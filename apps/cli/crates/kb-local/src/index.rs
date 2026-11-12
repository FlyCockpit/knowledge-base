//! Private, immutable, disposable FTS5 + vec0 files. Row transaction -> file
//! and directory fsync -> durable COMPLETE -> desired/attempt activation CAS.
use crate::{
    Store, StoreError,
    generations::*,
    index_format::{self, FileMeta, IndexQuantization},
    paths,
};
use kb_client::types::*;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BuildStage {
    /// Before each vector-reuse candidate is examined (review r2 #5).
    ReuseCandidate,
    Rows,
    BeforeFsync,
    AfterFsync,
    BeforeComplete,
    BeforeActivate,
    BeforeActivationCas,
}
impl Store {
    /// Opens a published file read-only after its header check, then verifies
    /// the single `meta` row (written last) against the immutable snapshot.
    pub(crate) fn open_generation_file(
        &self,
        s: &GenerationSnapshot,
    ) -> Result<(Connection, FileMeta), StoreError> {
        self.verify_generation_file(s, false)
            .map_err(|fault| match fault {
                FileFault::Corrupt | FileFault::Contract => StoreError::IndexUnavailable,
                // Any SQLite failure while verifying refuses the file (as before).
                FileFault::Transient(StoreError::Sqlite(_)) => StoreError::IndexUnavailable,
                FileFault::Transient(e) => e,
            })
    }
    /// Review #4: open and verify a published generation file, classifying
    /// a refusal: proven damage (`Corrupt`), a file that is not the index
    /// its generation row describes (`Contract`), or a failure that proves
    /// nothing about the file (`Transient`: I/O, locking, the state DB).
    /// `integrity` also runs `PRAGMA quick_check`.
    pub(crate) fn verify_generation_file(
        &self,
        s: &GenerationSnapshot,
        integrity: bool,
    ) -> Result<(Connection, FileMeta), FileFault> {
        let transient = FileFault::Transient;
        crate::sqlite_vec::register().map_err(transient)?;
        let path = self.paths.index_file(&s.kb_id, &s.id);
        self.paths.check_no_follow(&path).map_err(transient)?;
        let mut file =
            paths::open_no_follow(&path, OpenOptions::new().read(true)).map_err(transient)?;
        match index_format::header_valid(&mut file) {
            Ok(true) => {}
            Ok(false) => return Err(FileFault::Corrupt),
            Err(e) => return Err(transient(StoreError::Io(e))),
        }
        drop(file);
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(|e| FileFault::of_sqlite(StoreError::Sqlite(e)))?;
        if !conn
            .is_readonly(rusqlite::MAIN_DB)
            .map_err(|e| transient(StoreError::Sqlite(e)))?
        {
            return Err(FileFault::Contract);
        }
        crate::sqlite_vec::verify(&conn).map_err(FileFault::of_sqlite)?;
        if integrity {
            let check = conn
                .query_row("PRAGMA quick_check(1)", [], |r| r.get::<_, String>(0))
                .map_err(|e| FileFault::of_sqlite(StoreError::Sqlite(e)))?;
            if check != "ok" {
                return Err(FileFault::Corrupt);
            }
        }
        let meta = index_format::read_meta(&conn, s.is_lexical()).map_err(FileFault::of_sqlite)?;
        if integrity
            && !index_format::has_required_tables(&conn, &meta).map_err(FileFault::of_sqlite)?
        {
            return Err(FileFault::Contract);
        }
        // Review r2 #2: every stored vector has the file's width (malformed
        // rows pass `quick_check` but break distance queries).
        if integrity
            && let (Some(dims), Some(IndexQuantization::BinaryInt8Rescore)) =
                (meta.dimensions, meta.quantization)
        {
            let malformed: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM chunk_int8 WHERE length(e)<>?1) OR EXISTS(SELECT 1 FROM chunk_bits WHERE length(b)<>?2)",
                    (dims as i64, (index_format::bit_dimensions(dims) / 8) as i64),
                    |r| r.get(0),
                )
                .map_err(|e| FileFault::of_sqlite(StoreError::Sqlite(e)))?;
            if malformed {
                return Err(FileFault::Contract);
            }
        }
        // The local generation record holds the authoritative build counts
        // (the server compares its generation row the same way).
        let counts: Option<(Option<i64>, Option<i64>)> = self
            .conn
            .query_row(
                "SELECT document_count,chunk_count FROM index_generations WHERE id=?1 AND kb_id=?2",
                (s.id.as_str(), s.kb_id.as_str()),
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| transient(StoreError::Sqlite(e)))?;
        let Some((Some(documents), Some(chunks))) = counts else {
            return Err(transient(StoreError::IndexUnavailable));
        };
        let host = serde_json::from_str::<GenerationSnapshot>(&meta.host_snapshot).ok();
        if meta.generation_id != s.id.as_str()
            || meta.kb_id != s.kb_id.as_str()
            || meta.commit_sha != s.commit_sha.as_str()
            || meta.fingerprint.as_ref() != s.profile.as_ref().map(|p| &p.fingerprint)
            || meta.dimensions != s.profile.as_ref().map(|p| p.dimensions)
            || meta.quantization != s.profile.as_ref().map(|_| s.quantization)
            || i64::try_from(meta.document_count).ok() != Some(documents)
            || i64::try_from(meta.chunk_count).ok() != Some(chunks)
            || host.as_ref() != Some(s)
        {
            return Err(FileFault::Contract);
        }
        Ok((conn, meta))
    }
    fn build_check(&self, a: &BuildAttempt) -> Result<(), StoreError> {
        if self.paths.root() != a.root {
            return Err(StoreError::LockNotHeld);
        }
        Self::check_build_control(a)?;
        let _guard = self.lock_write(std::slice::from_ref(&a.snapshot.kb_id))?;
        Self::check_build_control(a)?;
        self.read_kb_locked(&_guard, &a.snapshot.kb_id)?;
        if !self.attempt_live(&a.snapshot, &a.token)?
            || !self.desired_matches(&a.snapshot)?
            || !self.generation_live(&a.snapshot, true)?
        {
            return Err(StoreError::IndexUnavailable);
        }
        Ok(())
    }
    fn reserve_index_storage(
        &self,
        a: &BuildAttempt,
        file: Option<&Connection>,
        next_bytes: u64,
    ) -> Result<u64, StoreError> {
        Self::check_build_control(a)?;
        let page_count: u64 = file
            .map(|c| c.pragma_query_value(None, "page_count", |r| crate::uploads::unsigned(r, 0)))
            .transpose()?
            .unwrap_or(0);
        let old: u64 = self.conn.query_row(
            "SELECT reserved_bytes FROM index_generations WHERE id=?1",
            [a.snapshot.id.as_str()],
            |r| crate::uploads::unsigned(r, 0),
        )?;
        let capacity = old.saturating_sub(crate::limits::WRITE_DISK_RESERVE_BYTES) / 2;
        let needed = (page_count * 4096)
            .checked_add(next_bytes)
            .ok_or_else(|| StoreError::QuotaExceeded("index storage".into()))?
            .div_ceil(4096)
            * 4096;
        if needed <= capacity {
            if !self.attempt_live(&a.snapshot, &a.token)? || !self.desired_matches(&a.snapshot)? {
                return Err(StoreError::IndexUnavailable);
            }
            return Ok(capacity);
        }
        let guard = self.lock_write(std::slice::from_ref(&a.snapshot.kb_id))?;
        Self::check_build_control(a)?;
        self.read_kb_locked(&guard, &a.snapshot.kb_id)?;
        if !self.attempt_live(&a.snapshot, &a.token)? || !self.desired_matches(&a.snapshot)? {
            return Err(StoreError::IndexUnavailable);
        }
        // Reserve in bounded slabs rather than fsyncing state.sqlite for
        // each document's few bytes of growth. max_page_count still enforces
        // the exact capacity whose disk admission committed first.
        const SLAB: u64 = 1024 * 1024;
        let capacity = needed.div_ceil(SLAB) * SLAB;
        // Every build uses one outer row transaction on a newly created file.
        // max_page_count bounds SQLite/vec/FTS pages; a second copy plus metadata
        // covers the DELETE rollback journal. Temp sort data stays in memory.
        let reserved = capacity
            .checked_mul(2)
            .and_then(|v| v.checked_add(crate::limits::WRITE_DISK_RESERVE_BYTES))
            .filter(|v| *v <= i64::MAX as u64)
            .ok_or_else(|| StoreError::QuotaExceeded("index storage".into()))?;
        let mut allocated = 0u64;
        for suffix in ["", "-journal"] {
            let path = self
                .paths
                .index_dir(&a.snapshot.kb_id)
                .join(format!("{}.tmp{suffix}", a.snapshot.id));
            self.paths.check_no_follow(&path)?;
            match paths::open_no_follow(&path, OpenOptions::new().read(true)) {
                Ok(f) => {
                    allocated = allocated
                        .checked_add(f.metadata().map_err(StoreError::Io)?.len())
                        .ok_or_else(|| StoreError::QuotaExceeded("index storage".into()))?
                }
                Err(StoreError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE index_generations SET allocated_bytes=?2 WHERE id=?1",
            (
                a.snapshot.id.as_str(),
                i64::try_from(allocated)
                    .map_err(|_| StoreError::QuotaExceeded("index storage".into()))?,
            ),
        )?;
        self.check_disk_admission(reserved.saturating_sub(old))?;
        tx.execute(
            "UPDATE index_generations SET reserved_bytes=?2 WHERE id=?1 AND attempt=?3",
            (a.snapshot.id.as_str(), reserved as i64, &a.token),
        )?;
        // (L-2): every admitted unit of work is progress; the watchdog and
        // the durable attempt lease move forward together.
        let until = a.until.extend();
        let lease_ms = self.now_ms().saturating_add(
            u64::try_from(
                until
                    .saturating_duration_since(std::time::Instant::now())
                    .as_millis(),
            )
            .unwrap_or(u64::MAX),
        );
        tx.execute(
            "UPDATE index_generations SET attempt_until_ms=max(attempt_until_ms,?3) WHERE id=?1 AND attempt=?2 AND state='BUILDING'",
            (
                a.snapshot.id.as_str(),
                &a.token,
                i64::try_from(lease_ms).unwrap_or(i64::MAX),
            ),
        )?;
        tx.commit()?; // reservation is durable BEFORE raising the SQLite cap
        if let Some(file) = file {
            file.pragma_update(None, "max_page_count", (capacity / 4096) as i64)?;
        }
        Ok(capacity)
    }
    fn heartbeat_build(&self, a: &BuildAttempt) -> Result<(), StoreError> {
        let _guard = self.lock_write(std::slice::from_ref(&a.snapshot.kb_id))?;
        Self::check_build_control(a)?;
        let until = a.until.extend();
        let lease_ms = self.now_ms().saturating_add(
            u64::try_from(
                until
                    .saturating_duration_since(std::time::Instant::now())
                    .as_millis(),
            )
            .unwrap_or(u64::MAX),
        );
        if self.conn.execute(
            "UPDATE index_generations SET attempt_until_ms=max(attempt_until_ms,?3) WHERE id=?1 AND attempt=?2 AND state='BUILDING'",
            (a.snapshot.id.as_str(), &a.token, i64::try_from(lease_ms).unwrap_or(i64::MAX)),
        )? != 1 {
            return Err(StoreError::IndexUnavailable);
        }
        Ok(())
    }
    fn check_build_control(a: &BuildAttempt) -> Result<(), StoreError> {
        if a.cancel.is_cancelled() {
            return Err(StoreError::OperationAborted(
                kb_client::ErrorCode::Cancelled,
            ));
        }
        if a.until.expired() {
            return Err(StoreError::WatchdogExpired);
        }
        Ok(())
    }
    /// Trusted host embedder receives only the immutable profile and redacted
    /// texts. Transport adapters below bind it to actual provider/native IO.
    pub async fn build_generation(
        &self,
        a: BuildAttempt,
        embed: impl AsyncFnMut(&ProfileSnapshot, &[String]) -> Result<Vec<Vec<f64>>, StoreError>,
        observer: &mut dyn FnMut(BuildStage) -> Result<(), StoreError>,
    ) -> Result<BuiltGeneration, StoreError> {
        self.build_generation_inner(a, embed, observer, None).await
    }
    async fn build_generation_inner(
        &self,
        a: BuildAttempt,
        mut embed: impl AsyncFnMut(&ProfileSnapshot, &[String]) -> Result<Vec<Vec<f64>>, StoreError>,
        observer: &mut dyn FnMut(BuildStage) -> Result<(), StoreError>,
        runtime: Option<&crate::qwen::ModelRuntime>,
    ) -> Result<BuiltGeneration, StoreError> {
        let mut code = "INDEX_BUILD_FAILED";
        let result = self
            .build_file(&a, &mut embed, observer, runtime, &mut code)
            .await;
        if let Err(e) = &result {
            let _guard = self.lock_write(&[])?;
            // (L-1): shutdown cancellation and the no-progress watchdog are
            // transient; the generation resumes from its checkpoint later.
            let progressed = a.progressed.load(std::sync::atomic::Ordering::Acquire);
            if matches!(
                e,
                StoreError::OperationAborted(kb_client::ErrorCode::Cancelled)
            ) {
                self.interrupt_generation(&a.snapshot, Some(&a.token), AttemptEnd::Interrupted)?;
            } else if matches!(e, StoreError::WatchdogExpired) {
                // Only the attempt's own no-progress watchdog is a stall.
                self.interrupt_generation(
                    &a.snapshot,
                    Some(&a.token),
                    AttemptEnd::WatchdogExpired { progressed },
                )?;
            } else if matches!(e, StoreError::DeadlineExceeded) {
                // A shorter admission, lock, Git or storage deadline while the
                // watchdog is live: transient, retried, never a stall. A real
                // embedding-call timeout is a build failure, like EmbeddingFailed.
                self.interrupt_generation(&a.snapshot, Some(&a.token), AttemptEnd::Interrupted)?;
            } else {
                self.fail_generation(&a.snapshot.id, Some(&a.token), code)?;
            }
        }
        result.map(|()| BuiltGeneration {
            snapshot: a.snapshot,
            token: a.token,
            root: a.root,
            until: a.until,
            cancel: a.cancel,
            _completion: a._completion,
        })
    }
    /// One bounded embedding request under the attempt's cancel/deadline.
    async fn embed_batch(
        a: &BuildAttempt,
        embed: &mut impl AsyncFnMut(&ProfileSnapshot, &[String]) -> Result<Vec<Vec<f64>>, StoreError>,
        texts: &[String],
    ) -> Result<Vec<Vec<f64>>, StoreError> {
        let result = tokio::select! {biased;
            _=a.cancel.cancelled()=>return Err(StoreError::OperationAborted(kb_client::ErrorCode::Cancelled)),
            result=tokio::time::timeout(a.until.remaining(),embed(a.snapshot.hybrid_profile()?,texts))=>result.map_err(|_|StoreError::WatchdogExpired)?,
        };
        // Native calls can block this executor, so the timer may not have polled.
        // Observe the watchdog here, before propagating the call's own error.
        Self::check_build_control(a)?;
        let vectors = result?;
        if vectors.len() != texts.len() {
            return Err(StoreError::IndexUnavailable);
        }
        Ok(vectors)
    }
    /// Shared format v1 (§1.2): pass 1 writes documents, chunks and FTS text
    /// and enforces the chunk limit before any embedding; pass 2 embeds the
    /// int8 calibration sample first, then every other chunk once, in id
    /// order. A lexical-only generation has no pass 2: no embedding,
    /// calibration or vector tables, and null profile columns in `meta`.
    /// `meta` is inserted last. Every byte is written under
    /// `<gen>.tmp` (journal_mode=DELETE), which is closed, fsynced, checked
    /// and then linked to its final name (never replacing a file).
    async fn build_file(
        &self,
        a: &BuildAttempt,
        embed: &mut impl AsyncFnMut(&ProfileSnapshot, &[String]) -> Result<Vec<Vec<f64>>, StoreError>,
        observer: &mut dyn FnMut(BuildStage) -> Result<(), StoreError>,
        runtime: Option<&crate::qwen::ModelRuntime>,
        code: &mut &'static str,
    ) -> Result<(), StoreError> {
        self.build_check(a)?;
        let s = &a.snapshot;
        let lexical = s.is_lexical();
        let dims = s.profile.as_ref().map_or(0, |p| p.dimensions);
        let q = s.quantization;
        if !lexical && !(1..=index_format::MAX_DIMENSIONS).contains(&dims) {
            return Err(StoreError::IndexUnavailable);
        }
        let chunk_limit = self.limits.get().index_chunks();
        crate::sqlite_vec::register()?;
        let capacity = self.reserve_index_storage(a, None, 16 * 1024 * 1024)?;
        let dir = self.paths.ensure_index_dir(&s.kb_id)?;
        let temp = self.paths.index_temp_file(&s.kb_id, &s.id);
        // A resumed attempt owns the KB build permit, so an earlier
        // attempt's scratch has no live writer: it is discarded, never adopted.
        // That includes a final name linked by an attempt killed before
        // COMPLETE: this generation is BUILDING, so no reader can lease it.
        for stale in [
            temp.clone(),
            dir.join(format!("{}.tmp-journal", s.id)),
            self.paths.index_file(&s.kb_id, &s.id),
            dir.join(format!("{}.sqlite-journal", s.id)),
        ] {
            self.paths.check_no_follow(&stale)?;
            match std::fs::remove_file(&stale) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(StoreError::Io(e)),
            }
        }
        let mut barrier = paths::open_no_follow(
            &temp,
            OpenOptions::new().read(true).write(true).create_new(true),
        )?;
        let conn = Connection::open_with_flags(
            &temp,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        crate::sqlite_vec::verify(&conn)?;
        for pragma in index_format::writer_pragmas()? {
            conn.execute_batch(pragma)?;
        }
        if conn.pragma_query_value(None, "journal_mode", |r| r.get::<_, String>(0))? != "delete" {
            return Err(StoreError::IndexUnavailable);
        }
        // CLI-only connection settings; neither changes the shared format.
        conn.execute_batch("PRAGMA temp_store=MEMORY; PRAGMA foreign_keys=ON;")?;
        conn.pragma_update(None, "max_page_count", (capacity / 4096) as i64)?;
        let ddl = if lexical {
            index_format::render_lexical_ddl()?
        } else {
            index_format::render_ddl(q, dims)?
        };
        for sql in ddl {
            conn.execute_batch(&sql)?;
        }
        #[cfg(test)]
        index_format::tests::install_flush_failure(&conn)?;
        let tx = conn.unchecked_transaction()?;
        let (repo, rev) = self.pinned_revision(&self.owner, &s.kb_id, Some(&s.commit_sha))?;
        let info = repo.object_reader()?.read_commit(&rev)?;
        let seconds = info
            .committer
            .rsplit(' ')
            .nth(1)
            .and_then(|s| s.parse::<u64>().ok())
            .ok_or(StoreError::IndexUnavailable)?;
        let stamp = crate::state::format_utc(seconds);
        let manifest = self.manifest_entries(&s.kb_id, &repo, &rev)?;
        // chunks.id = insertion order over documents in bytewise path order
        // and chunk_index order, so id order is (path, chunk_index) order.
        let mut reader = repo.object_reader()?;
        let mut walk = crate::git_read::WalkBudget::new(crate::tree::TREE_LIMITS.max_entries);
        let mut incoming = crate::git_read::IncomingBudget::new(
            crate::tree::TREE_LIMITS.max_objects,
            crate::tree::TREE_LIMITS.max_uncompressed_object_bytes,
            None,
        );
        let mut paths_at_rev =
            crate::git_read::walk_tree(&mut reader, &info.tree, &mut walk, &mut incoming)?
                .into_iter()
                .filter(|entry| {
                    entry.kind == crate::git_read::EntryKind::Blob && entry.path.ends_with(".md")
                })
                .map(|entry| {
                    KbPath::parse(&entry.path)
                        .map_err(|_| StoreError::RecoveryRequired("unnormalized path".into()))
                })
                .collect::<Result<Vec<_>, _>>()?;
        drop(reader);
        paths_at_rev.sort_by(|x, y| x.as_str().cmp(y.as_str()));
        // R3-L6: the reuse source is opened before pass 1 for a built-in
        // build, so context fitting skips the worker round trip for a chunk
        // whose exact text the previous file (same fingerprint, so the same
        // model and context) already stored: it fit then.
        let mut reuse_early = None;
        if !lexical && runtime.is_some() && s.builtin().is_some() {
            reuse_early = Some(self.reuse_source(a, observer)?);
        }
        let mut documents = 0u64;
        let mut chunks = 0u64;
        let mut text_bytes = 0u64;
        // R3-L6: documents are read in groups through one `cat-file --batch`
        // reader each, not three Git children and a manifest read apiece. The
        // reader is dropped before the group is processed: a live Git child
        // holds a store lease, and storage reservation takes the store fence.
        let mut paths = paths_at_rev.into_iter();
        let mut group = std::collections::VecDeque::new();
        loop {
            if group.is_empty() {
                self.build_check(a)?;
                self.heartbeat_build(a)?;
                let mut reader = repo.object_reader()?;
                let (started, mut bytes) = (std::time::Instant::now(), 0usize);
                while group.len() < READ_GROUP_DOCUMENTS
                    && bytes < READ_GROUP_BYTES
                    && started.elapsed() < READ_GROUP_TIME
                {
                    let Some(path) = paths.next() else { break };
                    // No store fence while the reader lives (see above).
                    Self::check_build_control(a)?;
                    let source = crate::git_read::read_document_at(
                        &mut reader,
                        &rev,
                        &info.tree,
                        path.as_str(),
                    )
                    .map_err(crate::documents::source_error)?;
                    bytes += source.markdown.len();
                    group.push_back(source);
                }
            }
            let Some(source) = group.pop_front() else {
                break;
            };
            // The revision was gated once per bounded group; keep local
            // cancellation and live read authority checks on every document.
            Self::check_build_control(a)?;
            self.authorize(&self.owner, &s.kb_id, kb_client::types::Permission::Read)?;
            let doc = crate::documents::document_from_source(source, &manifest, rev.clone())?;
            let mut source =
                crate::markdown::convert_markdown_source(&crate::markdown::ConversionInput {
                    media_type: "text/markdown",
                    bytes: doc.markdown.as_bytes(),
                    path: &doc.path,
                    commit_sha: &rev,
                    commit_timestamp: &stamp,
                    manifest_commit_sha: &rev,
                    manifest_entries: &manifest,
                })?;
            // Context fitting applies only to a pinned built-in profile; a
            // lexical generation's chunking never depends on an embedder.
            if let (Some(runtime), Some(state)) = (runtime, s.builtin()) {
                source.chunked = fit_context(
                    source.source.body(),
                    source.chunked,
                    state.context_tokens as usize,
                    |text| {
                        Self::check_build_control(a)?;
                        if let Some(Some(known)) = &reuse_early
                            && known.by_hash.contains_key(&index_format::chunk_hash(text))
                        {
                            return Ok(1);
                        }
                        let measured = runtime.measure_pinned(
                            self,
                            text,
                            a.until.remaining(),
                            state,
                            &a.cancel.token,
                        );
                        Self::check_build_control(a)?;
                        measured
                    },
                )?;
            }
            // Before any embedding spend (§1.9; the server-only bounds and
            // admin ceiling do not apply to the CLI).
            if chunks.saturating_add(source.chunked.chunks.len() as u64) > chunk_limit {
                *code = "INDEX_CHUNK_LIMIT_EXCEEDED";
                return Err(StoreError::QuotaExceeded("index chunks".into()));
            }
            let meta = &source.structured;
            let metadata = serde_json::json!({"type":meta.r#type,"title":meta.title,"titleFolded":meta.title_folded,"tags":meta.tags,"timestamp":meta.timestamp});
            let cite = serde_json::json!({"commitSha":rev,"blobSha":doc.blob_sha,"contentHash":doc.content_hash,"documentId":doc.document_id,"documentCitations":doc.document_citations,"assetRefs":doc.asset_refs});
            // Check emitted keys/decoded cells as well as complete source
            // rows; headers and JSON escapes can hide a credential from
            // the safe chunk that intersects only part of the row.
            let rows = meta
                .rows
                .iter()
                .filter_map(|row| {
                    if row.values.iter().any(|(key, value)| {
                        crate::sensitive_text::contains_known_credential_patterns(key)
                            || value.as_str().is_some_and(
                                crate::sensitive_text::contains_known_credential_patterns,
                            )
                    }) {
                        return None;
                    }
                    crate::sensitive_text::prepare_embedding_query(
                        &source.source.body()
                            [row.span.start_byte as usize..row.span.end_byte as usize],
                    )
                    .ok()
                    .map(|text| crate::citation::IndexedRow {
                        row: row.clone(),
                        snippet: crate::chunk::citation_snippet(&text),
                    })
                })
                .collect::<Vec<_>>();
            let chunk_bytes = source
                .chunked
                .chunks
                .iter()
                .map(|c| (c.text.len() + c.snippet.len()) as u64)
                .sum::<u64>();
            self.reserve_index_storage(
                a,
                Some(&conn),
                (doc.markdown.len() as u64
                    + chunk_bytes
                    + serde_json::to_vec(&meta.rows)
                        .map_err(|_| StoreError::IndexUnavailable)?
                        .len() as u64)
                    * 8
                    + 1024 * 1024,
            )?;
            tx.execute(
                "INSERT INTO documents VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                rusqlite::params![
                    doc.path.as_str(),
                    doc.blob_sha.as_str(),
                    doc.content_hash.as_str(),
                    doc.document_id,
                    serde_json::to_value(&source.chunked.state)
                        .map_err(|_| StoreError::IndexUnavailable)?
                        .as_str(),
                    source.chunked.original_window_count as i64,
                    cite.to_string(),
                    metadata.to_string(),
                    serde_json::to_string(&rows).map_err(|_| StoreError::IndexUnavailable)?
                ],
            )?;
            documents += 1;
            let mut insert =
                tx.prepare_cached("INSERT INTO chunks VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)")?;
            let mut insert_hash = tx.prepare_cached("INSERT INTO chunk_hash VALUES(?1,?2)")?;
            let mut previous = None;
            for chunk in &source.chunked.chunks {
                // Writer invariants (TS `appendDocument`): strictly increasing
                // ordinals below the window count, chunks only when INDEXED.
                if previous.is_some_and(|p| chunk.chunk_index <= p)
                    || chunk.chunk_index >= source.chunked.original_window_count
                    || source.chunked.state != crate::chunk::DocumentState::Indexed
                {
                    return Err(StoreError::IndexUnavailable);
                }
                previous = Some(chunk.chunk_index);
                chunks += 1;
                insert.execute(rusqlite::params![
                    chunks as i64,
                    doc.path.as_str(),
                    chunk.chunk_index as i64,
                    chunk.span.start_token as i64,
                    chunk.span.end_token as i64,
                    chunk.span.start_byte as i64,
                    chunk.span.end_byte as i64,
                    chunk.text,
                    chunk.snippet
                ])?;
                insert_hash.execute(rusqlite::params![
                    chunks as i64,
                    index_format::chunk_hash(&chunk.text).as_slice()
                ])?;
                text_bytes += chunk.text.len() as u64;
            }
        }
        // Pass 2. Reuse first: an unchanged chunk (same text hash under
        // the same fingerprint) copies its stored vectors from the active file
        // when this build inherits that file's int8 scale (enough reuse), or
        // its exact unit vector from the KB checkpoint; only the rest is
        // embedded, batch by batch, each batch committed to the checkpoint
        // before it is written. Calibration (a fresh scale) samples unit
        // vectors the same way, so each chunk is still embedded at most once.
        let hash_of = |id: u64| -> Result<[u8; 32], StoreError> {
            let raw: Vec<u8> =
                tx.query_row("SELECT h FROM chunk_hash WHERE id=?1", [id as i64], |r| {
                    r.get(0)
                })?;
            <[u8; 32]>::try_from(raw.as_slice()).map_err(|_| StoreError::IndexUnavailable)
        };
        let text_of = |id: u64| -> Result<String, StoreError> {
            Ok(
                tx.query_row("SELECT text FROM chunks WHERE id=?1", [id as i64], |r| {
                    r.get(0)
                })?,
            )
        };
        // The one normalization of every raw embedding (§1.4).
        let unit = |raw: Vec<f64>| index_format::unit_vector(&raw, dims);
        let checkpoint = match &s.profile {
            Some(pin) if !lexical => {
                let cache =
                    crate::vector_cache::VectorCache::open(&self.paths, &s.kb_id, &s.id, pin)?;
                // Invariant 2: only this generation's chunks stay checkpointed.
                let mut hashes = Vec::with_capacity(usize::try_from(chunks).unwrap_or(0));
                for id in 1..=chunks {
                    hashes.push(hash_of(id)?);
                }
                cache.retain(&hashes)?;
                Some(cache)
            }
            _ => None,
        };
        let reuse = if lexical || chunks == 0 {
            None
        } else if let Some(early) = reuse_early {
            early
        } else {
            self.reuse_source(a, observer)?
        };
        let reused_hits = match &reuse {
            Some(r) => {
                let mut hits = 0u64;
                for id in 1..=chunks {
                    if id % 1024 == 0 {
                        self.build_check(a)?;
                    }
                    if r.by_hash.contains_key(&hash_of(id)?) {
                        hits += 1;
                    }
                }
                hits
            }
            None => 0,
        };
        let inherit = reuse.filter(|_| {
            reused_hits as f64
                >= index_format::vector_reuse_min_fraction().unwrap_or(1.) * chunks as f64
        });
        // The built-in embeds one text at a time anyway: checkpoint each one,
        // so even a short session keeps its work. Providers keep 32.
        let batch_size = if s.builtin().is_some() { 1 } else { 32 };
        // Embeds the misses of one batch, checkpoints them, then admits the
        // batch as progress (watchdog + lease).
        let mut fresh_units =
            async |ids: &[u64]| -> Result<std::collections::BTreeMap<u64, Vec<f32>>, StoreError> {
                let mut out = std::collections::BTreeMap::new();
                let mut missing = vec![];
                for id in ids {
                    let hash = hash_of(*id)?;
                    match checkpoint
                        .as_ref()
                        .map(|c| c.get(&hash))
                        .transpose()?
                        .flatten()
                    {
                        Some(cached) => {
                            out.insert(*id, cached);
                        }
                        None => missing.push((*id, hash)),
                    }
                }
                if missing.is_empty() {
                    return Ok(out);
                }
                let texts = missing
                    .iter()
                    .map(|(id, _)| text_of(*id))
                    .collect::<Result<Vec<_>, _>>()?;
                let vectors = Self::embed_batch(a, embed, &texts).await?;
                self.build_check(a)?;
                let units = vectors
                    .into_iter()
                    .map(unit)
                    .collect::<Result<Vec<_>, _>>()?;
                if let Some(c) = &checkpoint {
                    self.check_disk_admission(c.row_bytes() * units.len() as u64)?;
                    c.put_batch(
                        &missing
                            .iter()
                            .zip(&units)
                            .map(|((_, hash), u)| (*hash, u.as_slice()))
                            .collect::<Vec<_>>(),
                    )?;
                }
                self.heartbeat_build(a)?;
                a.progressed
                    .store(true, std::sync::atomic::Ordering::Release);
                for ((id, _), u) in missing.into_iter().zip(units) {
                    out.insert(id, u);
                }
                Ok(out)
            };
        let mut sampled = std::collections::BTreeMap::<u64, Vec<f32>>::new();
        let scale = if lexical {
            a.progressed
                .store(true, std::sync::atomic::Ordering::Release);
            None
        } else if chunks == 0 {
            Some(index_format::empty_index_int8_scale()?)
        } else if let Some(r) = &inherit {
            Some(r.scale)
        } else {
            for batch in index_format::calibration_ids(chunks).chunks(batch_size) {
                self.build_check(a)?;
                let units = fresh_units(batch).await?;
                // Capacity for these vectors is admitted before the next
                // dispatch, exactly as for every later batch.
                self.reserve_index_storage(
                    a,
                    Some(&conn),
                    16 * 1024 * 1024
                        + index_format::vector_bytes_per_chunk(q, dims) * batch.len() as u64,
                )?;
                sampled.extend(units);
            }
            Some(index_format::int8_scale(
                sampled.values().map(Vec::as_slice),
            )?)
        };
        let per_chunk = index_format::vector_bytes_per_chunk(q, dims);
        let mut vectors = index_format::VectorWriter::new(dims);
        let mut first = 1u64;
        // A lexical file has no pass 2 (no embedding, no vector rows).
        // Blocks of up to 256 ids: reused rows cost no embedding, so an
        // all-reused rebuild still checks its attempt and heartbeats once per
        // block; misses are embedded `batch_size` at a time, each batch its
        // own unit of progress (watchdog + lease).
        while !lexical && first <= chunks {
            self.build_check(a)?;
            let last = (first + REUSE_BLOCK - 1).min(chunks);
            let ids = (first..=last).collect::<Vec<_>>();
            first = last + 1;
            let mut rows = std::collections::BTreeMap::new();
            let mut needed = vec![];
            for id in &ids {
                if let Some(u) = sampled.remove(id) {
                    rows.insert(*id, index_format::VectorRow::Unit(u));
                    continue;
                }
                // A stored vector the source cannot return (a damaged page)
                // is embedded again under the inherited scale instead.
                if let Some(r) = &inherit
                    && let Some(old) = r.by_hash.get(&hash_of(*id)?)
                    && let Ok(row) = r.stored(*old, q, dims)
                {
                    rows.insert(*id, row);
                    continue;
                }
                needed.push(*id);
            }
            for misses in needed.chunks(batch_size) {
                self.build_check(a)?;
                for (id, u) in fresh_units(misses).await? {
                    rows.insert(id, index_format::VectorRow::Unit(u));
                }
                self.reserve_index_storage(
                    a,
                    Some(&conn),
                    16 * 1024 * 1024 + per_chunk * misses.len() as u64,
                )?;
            }
            self.reserve_index_storage(
                a,
                Some(&conn),
                16 * 1024 * 1024 + per_chunk * ids.len() as u64,
            )?;
            self.heartbeat_build(a)?;
            for id in ids {
                let row = rows.remove(&id).ok_or(StoreError::IndexUnavailable)?;
                vectors.append_row(&tx, q, id, row, scale)?;
            }
        }
        drop(checkpoint);
        self.build_check(a)?;
        if !lexical {
            vectors.flush(&tx, q, scale)?;
        }
        observer(BuildStage::Rows)?;
        self.build_check(a)?;
        self.reserve_index_storage(a, Some(&conn), text_bytes * 8 + 4 * 1024 * 1024)?;
        tx.execute("INSERT INTO chunk_fts(chunk_fts) VALUES('rebuild')", [])?;
        tx.execute(
            "INSERT INTO chunk_fts(chunk_fts,rank) VALUES('integrity-check',1)",
            [],
        )?;
        let vector_rows = match q {
            // No vector tables: both vector counts are the chunk count.
            _ if lexical => "(SELECT count(*) FROM chunks),(SELECT count(*) FROM chunks)",
            IndexQuantization::BinaryInt8Rescore => {
                "(SELECT count(*) FROM chunk_bits),(SELECT count(*) FROM chunk_int8)"
            }
            _ => "(SELECT count(*) FROM chunk_vec),(SELECT count(*) FROM chunk_vec)",
        };
        let counts: (i64, i64, i64, i64, i64) = tx.query_row(
            &format!("SELECT (SELECT count(*) FROM documents),(SELECT count(*) FROM chunks),{vector_rows},(SELECT count(*) FROM chunk_hash)"),
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )?;
        let (documents, chunks) = (documents as i64, chunks as i64);
        if counts != (documents, chunks, chunks, chunks, chunks) || !sampled.is_empty() {
            return Err(StoreError::IndexUnavailable);
        }
        tx.execute(
            "INSERT INTO meta VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            rusqlite::params![
                index_format::format_version()?,
                s.id.as_str(),
                s.kb_id.as_str(),
                s.commit_sha.as_str(),
                s.profile.as_ref().map(|p| p.fingerprint.as_str()),
                s.profile.as_ref().map(|p| p.dimensions as i64),
                s.profile.as_ref().map(|_| q.as_str()),
                scale,
                documents,
                chunks,
                index_format::vec_version()?,
                serde_json::to_string(s).map_err(|_| StoreError::IndexUnavailable)?
            ],
        )?;
        tx.commit()?;
        conn.close().map_err(|(_, e)| StoreError::Sqlite(e))?;
        observer(BuildStage::BeforeFsync)?;
        self.build_check(a)?;
        barrier.sync_all().map_err(StoreError::Io)?;
        use std::io::Seek;
        barrier
            .seek(std::io::SeekFrom::Start(0))
            .map_err(StoreError::Io)?;
        index_format::check_header(&mut barrier)?;
        drop(barrier);
        let journal = dir.join(format!("{}.tmp-journal", s.id));
        self.paths.check_no_follow(&journal)?;
        match std::fs::symlink_metadata(&journal) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(StoreError::IndexUnavailable),
        }
        // Publish: a link never replaces an existing final file (EEXIST).
        let path = self.paths.index_file(&s.kb_id, &s.id);
        self.paths.check_no_follow(&path)?;
        std::fs::hard_link(&temp, &path).map_err(StoreError::Io)?;
        std::fs::remove_file(&temp).map_err(StoreError::Io)?;
        paths::sync_dir(&dir)?;
        observer(BuildStage::AfterFsync)?;
        self.build_check(a)?;
        observer(BuildStage::BeforeComplete)?;
        self.build_check(a)?;
        let _guard = self.lock_write(std::slice::from_ref(&s.kb_id))?;
        Self::check_build_control(a)?;
        let tx = self.conn.unchecked_transaction()?;
        if !self.desired_matches(s)?
            || !self.generation_live(s, true)?
            || !self.attempt_live(s, &a.token)?
        {
            return Err(StoreError::IndexUnavailable);
        }
        if tx.execute("UPDATE index_generations SET state='COMPLETE',reserved_bytes=0,finished_ms=?3,document_count=?4,chunk_count=?5 WHERE id=?1 AND attempt=?2 AND state='BUILDING'",(s.id.as_str(),&a.token,i64::try_from(self.now_ms()).unwrap_or(i64::MAX),documents,chunks))?!=1{return Err(StoreError::IndexUnavailable)}
        tx.execute(
            "UPDATE index_jobs SET state='COMPLETE' WHERE generation_id=?1",
            [s.id.as_str()],
        )?;
        tx.commit()?;
        Ok(())
    }
}

/// Pass-2 block of chunk ids: one attempt check and heartbeat per block.
const REUSE_BLOCK: u64 = 256;
/// Host-owned IO adapters; agents cannot supply keys, endpoint or native binary.
pub enum IndexEmbedder<'a> {
    Routed {
        keys: &'a dyn crate::credentials::Credentials,
        egress: &'a crate::egress::PinnedEgress<'a>,
        builtin: &'a crate::qwen::ModelRuntime,
    },
    External {
        keys: &'a dyn crate::credentials::Credentials,
        egress: &'a crate::egress::PinnedEgress<'a>,
    },
    Builtin(&'a crate::qwen::ModelRuntime),
}
impl Store {
    pub async fn build_index(
        &self,
        attempt: BuildAttempt,
        embedder: IndexEmbedder<'_>,
    ) -> Result<bool, StoreError> {
        let until = attempt.until.clone();
        let cancel = attempt.cancel.token.clone();
        let runtime = match &embedder {
            IndexEmbedder::Builtin(r) | IndexEmbedder::Routed { builtin: r, .. } => Some(*r),
            _ => None,
        };
        let built = self
            .build_generation_inner(
                attempt,
                async |pin, texts| match (&embedder, &pin.builtin) {
                    (
                        IndexEmbedder::External { keys, egress }
                        | IndexEmbedder::Routed { keys, egress, .. },
                        None,
                    ) => {
                        self.provider_embed(
                            &self.owner,
                            &pin.provider_id,
                            pin.revision,
                            texts,
                            *keys,
                            egress,
                            &crate::embedder::ProviderControl::default(),
                        )
                        .await
                    }
                    (
                        IndexEmbedder::Builtin(runtime)
                        | IndexEmbedder::Routed {
                            builtin: runtime, ..
                        },
                        Some(state),
                    ) => texts
                        .iter()
                        .map(|text| {
                            runtime
                                .embed_generation(self, text, until.remaining(), state, &cancel)
                                .map(|e| e.vector.into_iter().map(f64::from).collect())
                        })
                        .collect(),
                    _ => Err(StoreError::IndexUnavailable),
                },
                &mut |_| Ok(()),
                runtime,
            )
            .await?;
        self.activate_built(built)
    }
}

/// The KB's active generation file when it shares this build's profile
/// fingerprint, dimensions and quantization: its int8 scale, the first chunk
/// id of every text hash (computed from the text in a v1 file), and the open
/// read-only connection the stored vector bytes are copied from.
pub(crate) struct ReuseSource {
    conn: Connection,
    pub(crate) scale: f64,
    pub(crate) by_hash: std::collections::HashMap<[u8; 32], i64>,
}
impl ReuseSource {
    /// The stored vector of chunk `id`, decoded and validated against the
    /// build's dimensions (review r2 #2); a row that fails is embedded again.
    pub(crate) fn stored(
        &self,
        id: i64,
        q: IndexQuantization,
        dims: usize,
    ) -> Result<index_format::VectorRow, StoreError> {
        let blob = |sql: &str| -> Result<Vec<u8>, StoreError> {
            Ok(self.conn.query_row(sql, [id], |r| r.get(0))?)
        };
        let (bits, int8) = match q {
            IndexQuantization::BinaryInt8Rescore => (
                Some(blob("SELECT b FROM chunk_bits WHERE id=?1")?),
                blob("SELECT e FROM chunk_int8 WHERE id=?1")?,
            ),
            IndexQuantization::Int8 => (
                None,
                blob("SELECT embedding FROM chunk_vec WHERE rowid=?1")?,
            ),
        };
        Ok(index_format::VectorRow::Stored(
            index_format::StoredVector::decode(q, dims, bits, int8)?,
        ))
    }
}
impl Store {
    fn reuse_source(
        &self,
        a: &BuildAttempt,
        observer: &mut dyn FnMut(BuildStage) -> Result<(), StoreError>,
    ) -> Result<Option<ReuseSource>, StoreError> {
        let s = &a.snapshot;
        let Some(pin) = &s.profile else {
            return Ok(None);
        };
        // The newest retained semantic file of this profile (the active one
        // first): while lexical@head serves the previous semantic
        // generation is retired but still the reuse source. Retention cannot
        // reclaim it meanwhile: it skips KBs whose build permit is held.
        // R3-L2: candidates are walked in bounded pages (active first, then
        // newest epoch) until one is usable; a candidate that cannot serve
        // (superseded mid-build so never published, unreadable, another
        // quantization, no vectors, a damaged hash table) falls through to
        // the next, and none at all means re-embedding. Only the attempt's
        // own cancellation, watchdog or deadline stops the walk.
        const PAGE: i64 = 16;
        let control = |e: &StoreError| {
            matches!(
                e,
                StoreError::OperationAborted(_)
                    | StoreError::WatchdogExpired
                    | StoreError::DeadlineExceeded
            )
        };
        let base = "SELECT g.id,g.epoch FROM index_generations g WHERE g.kb_id=?1 AND g.id<>?2 AND g.reclaimed=0 AND g.state IN ('COMPLETE','SUPERSEDED') AND json_extract(g.snapshot_json,'$.profile.fingerprint')=?3 AND json_extract(g.snapshot_json,'$.profile.dimensions')=?4";
        let active: Option<(String, i64)> = self
            .conn
            .query_row(
                &format!("{base} AND g.id=(SELECT active_generation_id FROM kbs WHERE id=?1)"),
                rusqlite::params![
                    s.kb_id.as_str(),
                    s.id.as_str(),
                    pin.fingerprint,
                    pin.dimensions as i64
                ],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let mut after: Option<(i64, String)> = None;
        let mut first = active.clone().into_iter().collect::<Vec<_>>();
        loop {
            let page = if !first.is_empty() {
                std::mem::take(&mut first)
            } else {
                let (epoch, id) = after.clone().unwrap_or((i64::MAX, String::new()));
                let rows = self
                    .conn
                    .prepare(&format!(
                        "{base} AND (g.epoch<?5 OR (g.epoch=?5 AND g.id<?6 AND ?6<>'')) AND g.id IS NOT (SELECT active_generation_id FROM kbs WHERE id=?1) ORDER BY g.epoch DESC,g.id DESC LIMIT ?7"
                    ))?
                    .query_map(
                        rusqlite::params![
                            s.kb_id.as_str(),
                            s.id.as_str(),
                            pin.fingerprint,
                            pin.dimensions as i64,
                            epoch,
                            id,
                            PAGE
                        ],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
                    )?
                    .collect::<Result<Vec<_>, _>>()?;
                if rows.is_empty() {
                    return Ok(None);
                }
                rows
            };
            for (candidate, epoch) in page {
                if active.as_ref().is_none_or(|(a, _)| *a != candidate) {
                    after = Some((epoch, candidate.clone()));
                }
                // Review r2 #5: the attempt's cancellation and watchdog are
                // observed between candidates and inside each one's load.
                observer(BuildStage::ReuseCandidate)?;
                Self::check_build_control(a)?;
                let old = self.generation_snapshot(
                    &KbId::parse(&candidate).map_err(|_| StoreError::IndexUnavailable)?,
                )?;
                if old.quantization != s.quantization {
                    continue;
                }
                match Self::load_reuse_source(a, self.open_generation_file(&old)) {
                    Ok(Some(source)) => return Ok(Some(source)),
                    Ok(None) => {}
                    Err(e) if control(&e) => return Err(e),
                    // An interrupted statement was the attempt's own control;
                    // otherwise this candidate cannot serve, the next may.
                    Err(_) => Self::check_build_control(a)?,
                }
            }
        }
    }
    /// One candidate's file as a reuse source: its scale and every chunk
    /// hash (`None` without vectors). Any failure belongs to this candidate.
    fn load_reuse_source(
        a: &BuildAttempt,
        opened: Result<(Connection, index_format::FileMeta), StoreError>,
    ) -> Result<Option<ReuseSource>, StoreError> {
        let (mut conn, meta) = opened?;
        // Long statements stop when the attempt is cancelled or its
        // watchdog expires (SQLite progress handler).
        let (cancel, until) = (a.cancel.clone(), a.until.clone());
        conn.progress_handler(1000, Some(move || cancel.is_cancelled() || until.expired()))?;
        let Some(scale) = meta.int8_scale.filter(|_| meta.chunk_count > 0) else {
            return Ok(None);
        };
        let mut by_hash = std::collections::HashMap::new();
        {
            let mut q = conn.prepare("SELECT id,h FROM chunk_hash ORDER BY id")?;
            let mut rows = q.query([])?;
            let mut read = 0usize;
            while let Some(r) = rows.next()? {
                read += 1;
                if read.is_multiple_of(4096) {
                    Self::check_build_control(a)?;
                }
                let id: i64 = r.get(0)?;
                let raw: Vec<u8> = r.get(1)?;
                let hash = <[u8; 32]>::try_from(raw.as_slice())
                    .map_err(|_| StoreError::IndexUnavailable)?;
                by_hash.entry(hash).or_insert(id);
            }
        }
        Ok(Some(ReuseSource {
            conn,
            scale,
            by_hash,
        }))
    }
}

/// Why a generation file was refused (review #4).
#[derive(Debug)]
pub(crate) enum FileFault {
    /// Proven damage: a bad header, a corrupt page, a failed integrity check.
    Corrupt,
    /// Not the index its generation describes: wrong meta, format or schema.
    Contract,
    /// Proves nothing about the file (I/O, locking, the state database).
    Transient(StoreError),
}
impl FileFault {
    /// A SQLite failure reading the file: damage codes are corruption, I/O,
    /// locking and resource codes are transient, the rest (a missing table,
    /// a wrong column type) breaks the index contract.
    fn of_sqlite(e: StoreError) -> Self {
        let StoreError::Sqlite(rusqlite::Error::SqliteFailure(f, _)) = &e else {
            return match e {
                StoreError::IndexUnavailable => Self::Contract,
                StoreError::Sqlite(_) => Self::Contract,
                e => Self::Transient(e),
            };
        };
        match f.code {
            rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase => {
                Self::Corrupt
            }
            rusqlite::ErrorCode::SystemIoFailure
            | rusqlite::ErrorCode::DatabaseBusy
            | rusqlite::ErrorCode::DatabaseLocked
            | rusqlite::ErrorCode::OutOfMemory
            | rusqlite::ErrorCode::CannotOpen
            | rusqlite::ErrorCode::OperationInterrupted
            | rusqlite::ErrorCode::PermissionDenied
            | rusqlite::ErrorCode::FileLockingProtocolFailed => Self::Transient(e),
            _ => Self::Contract,
        }
    }
}

/// One document read group of a build (R3-L6): bounded in count, bytes and
/// time (well inside the Git child timeout, `git_read::GIT_TIMEOUT`).
const READ_GROUP_DOCUMENTS: usize = 64;
const READ_GROUP_BYTES: usize = 16 * 1024 * 1024;
const READ_GROUP_TIME: std::time::Duration = std::time::Duration::from_secs(20);

/// Use the pinned model's exact prefix/BOS/EOS token count. Split source
/// words, then Unicode scalars for pathological words; sealed references remain
/// indivisible. Missing/redacted windows still occupy accounting ordinals.
fn fit_context(
    body: &str,
    original: crate::chunk::ChunkedBody,
    limit: usize,
    mut measure: impl FnMut(&str) -> Result<usize, StoreError>,
) -> Result<crate::chunk::ChunkedBody, StoreError> {
    use crate::chunk::{ChunkedBody, DocumentState, SourceChunk, citation_snippet, source_tokens};
    use std::collections::{BTreeMap, VecDeque};
    if original.chunks.is_empty() {
        return Ok(original);
    }
    let tokens = source_tokens(body);
    let sealed = crate::markdown::sealed_ranges(body);
    let mut windows = BTreeMap::new();
    let mut changed = false;
    for chunk in &original.chunks {
        let mut pending = VecDeque::from([(
            chunk.span.start_byte as usize..chunk.span.end_byte as usize,
            chunk.text.clone(),
        )]);
        let mut done = Vec::new();
        while let Some((range, text)) = pending.pop_front() {
            let count = measure(&text)?;
            if count == 0 {
                return Err(StoreError::IndexUnavailable);
            }
            if count <= limit && text.len() <= crate::qwen::MAX_TEXT_BYTES {
                done.push((range, text));
                continue;
            }
            changed = true;
            // Token compression can satisfy context while exceeding the
            // native worker's text admission bound. Fit both before dispatch.
            let count = count.max(
                text.len()
                    .saturating_mul(limit)
                    .div_ceil(crate::qwen::MAX_TEXT_BYTES),
            );
            let first = tokens.partition_point(|r| r.start < range.start);
            let last = tokens.partition_point(|r| r.end <= range.end);
            let mut units = tokens[first..last.max(first)].to_vec();
            if units.len() < 3 {
                units.clear();
                let mut at = range.start;
                let mut symbol = sealed.partition_point(|s| s.start < at);
                while at < range.end {
                    while sealed.get(symbol).is_some_and(|s| s.start < at) {
                        symbol += 1;
                    }
                    let end = sealed.get(symbol).filter(|s| s.start == at).map_or_else(
                        || {
                            at + body[at..]
                                .chars()
                                .next()
                                .expect("nonempty source")
                                .len_utf8()
                        },
                        |s| s.end,
                    );
                    units.push(at..end);
                    at = end;
                }
            }
            if units.len() < 2 {
                return Err(StoreError::IndexUnavailable);
            }
            let size = ((units.len() as f64 * limit as f64 * 0.9 / count as f64) as usize)
                .max(if units.len() >= 3 { 2 } else { 1 })
                .min(units.len() - 1);
            let overlap = if size >= 2 {
                (size * crate::chunk::CHUNK_OVERLAP / crate::chunk::CHUNK_WORDS).max(1)
            } else {
                0
            };
            for first in (0..units.len()).step_by(size - overlap) {
                let last = (first + size).min(units.len()) - 1;
                let raw = &body[units[first].start..units[last].end];
                let trimmed = raw.trim();
                if !trimmed.is_empty() {
                    let start = units[first].start + raw.len() - raw.trim_start().len();
                    let range = start..start + trimmed.len();
                    if let Ok(safe) = crate::sensitive_text::prepare_embedding_query(trimmed) {
                        pending.push_back((
                            range,
                            safe.split_whitespace().collect::<Vec<_>>().join(" "),
                        ));
                    } else {
                        done.push((range, String::new()));
                    }
                }
                if last == units.len() - 1 {
                    break;
                }
            }
        }
        done.sort_by_key(|(r, _)| (r.start, r.end));
        windows.insert(chunk.chunk_index, done);
    }
    if !changed {
        return Ok(original);
    }
    let mut chunks = Vec::new();
    let mut index = 0;
    for window in 0..original.original_window_count {
        let Some(pieces) = windows.remove(&window) else {
            index += 1;
            continue;
        };
        for (range, text) in pieces {
            let chunk_index = index;
            index += 1;
            if text.is_empty() {
                continue;
            }
            let start = tokens.partition_point(|r| r.end <= range.start);
            let end = tokens.partition_point(|r| r.start < range.end);
            chunks.push(SourceChunk {
                chunk_index,
                span: CitationSpan {
                    start_token: start as u64,
                    end_token: end as u64,
                    start_byte: range.start as u64,
                    end_byte: range.end as u64,
                },
                snippet: citation_snippet(&text),
                text,
            });
        }
    }
    Ok(ChunkedBody {
        state: if chunks.is_empty() {
            DocumentState::SkippedRedacted
        } else {
            DocumentState::Indexed
        },
        original_window_count: index,
        chunks,
    })
}

#[cfg(test)]
mod context_tests {
    use super::fit_context;
    use crate::chunk::chunk_body;
    #[test]
    fn fitting_scale_output_witness() {
        for (words, expected) in [
            (
                100,
                "sha256:52b2414e2d5b28fc099c07dabab83eefb57f5383644fc39e47d199a29c750d1e",
            ),
            (
                1000,
                "sha256:58b9f1ead7f613970c9f647e6f6eb50d24335d0e08bf7394b62f24ecfa0d75d6",
            ),
            (
                10000,
                "sha256:8a0ea5ae02cc91bbd35d589e79124ef4d19a0ece40c32e660b9ecec421412b6d",
            ),
        ] {
            let body = vec!["語".repeat(32); words].join(" ");
            let started = std::time::Instant::now();
            let fitted = fit_context(&body, chunk_body(&body), 1024, |text| Ok(text.len() + 2))
                .expect("fit");
            let digest =
                kb_client::snapshot::content_hash(&serde_json::to_vec(&fitted).expect("encode"));
            assert_eq!(
                digest.to_string(),
                expected,
                "historical fitted output, including ordinals and overlap"
            );
            use std::io::Write;
            writeln!(
                std::io::stderr(),
                "context-scale words={words} bytes={} chunks={} elapsed={:?} digest={digest}",
                body.len(),
                fitted.chunks.len(),
                started.elapsed()
            )
            .expect("measurement output");
            for chunk in &fitted.chunks {
                assert_eq!(
                    &body[chunk.span.start_byte as usize..chunk.span.end_byte as usize],
                    chunk.text
                );
                assert!(chunk.text.len() + 2 <= 1024);
            }
        }
    }
    #[test]
    fn fitting_scalar_sealed_scale_preserves_canonical_text_and_spans() {
        use std::io::Write;
        for repetitions in [100, 1000, 10000] {
            let body = vec![format!("{} {{{{sealed:v1:knowledge_base:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222}}}}", "語".repeat(32)); repetitions].join(" ");
            assert!(body.len() <= 2 * 1024 * 1024);
            let started = std::time::Instant::now();
            let fitted = fit_context(&body, chunk_body(&body), 32, |text| Ok(text.len() + 2))
                .expect("scalar/sealed fit");
            let elapsed = started.elapsed();
            let symbols = crate::markdown::sealed_ranges(&body);
            for c in &fitted.chunks {
                let start = c.span.start_byte as usize;
                let end = c.span.end_byte as usize;
                let canonical = crate::sensitive_text::prepare_embedding_query(&body[start..end])
                    .expect("canonical source");
                assert_eq!(
                    c.text,
                    canonical.split_whitespace().collect::<Vec<_>>().join(" ")
                );
                assert!(c.text.len() + 2 <= 32);
                let first = symbols.partition_point(|s| s.end <= start);
                let last = symbols.partition_point(|s| s.start < end);
                for symbol in &symbols[first..last] {
                    assert!(start <= symbol.start && end >= symbol.end);
                }
            }
            writeln!(std::io::stderr(),"scalar-sealed-scale repetitions={repetitions} bytes={} chunks={} elapsed={elapsed:?}",body.len(),fitted.chunks.len()).expect("measurement output");
        }
    }
    #[test]
    fn fitting_also_bounds_native_text_bytes_when_tokens_compress() {
        let body = "z".repeat(300_000);
        let fitted = fit_context(&body, chunk_body(&body), 8192, |text| {
            Ok(text.len().div_ceil(64) + 4)
        })
        .expect("compressed tokens fit");
        assert!(fitted.chunks.len() > 1);
        for chunk in fitted.chunks {
            assert!(chunk.text.len() <= crate::qwen::MAX_TEXT_BYTES);
            assert!(chunk.text.len().div_ceil(64) + 4 <= 8192);
            assert_eq!(
                &body[chunk.span.start_byte as usize..chunk.span.end_byte as usize],
                chunk.text
            );
        }
    }
    #[test]
    fn fitting_preserves_small_windows_and_redacts_whole_symbols() {
        let short = chunk_body("small window");
        assert_eq!(
            fit_context("small window", short.clone(), 32, |_| Ok(2))
                .expect("context fitting succeeds"),
            short
        );
        let body = format!(
            "{} {{{{sealed:v1:knowledge_base:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222}}}}",
            "語".repeat(100)
        );
        let fitted = fit_context(&body, chunk_body(&body), 32, |s| Ok(s.len() + 2))
            .expect("context fitting succeeds");
        assert!(fitted.chunks.len() > 1);
        for c in fitted.chunks {
            assert!(body.is_char_boundary(c.span.start_byte as usize));
            assert!(body.is_char_boundary(c.span.end_byte as usize));
            assert!(!c.text.contains("11111111-1111-4111-8111-111111111111"));
            for symbol in crate::markdown::sealed_ranges(&body) {
                if (c.span.start_byte as usize) < symbol.end
                    && (c.span.end_byte as usize) > symbol.start
                {
                    assert!(
                        (c.span.start_byte as usize) <= symbol.start
                            && (c.span.end_byte as usize) >= symbol.end
                    );
                }
            }
            assert!(c.text.len() + 2 <= 32);
        }
    }
}
