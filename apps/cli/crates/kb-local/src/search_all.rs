//! `knowledge_search_all` over the managed store: the existing single-base
//! search run once per base, unchanged (its own authorization, query permit,
//! per-KB rate window, breaker, lexical fallback and final check), two bases
//! at a time under one shared deadline, then a final read recheck and a
//! rank-interleaved merge. Scores are never compared across bases.
//!
//! Nothing outlives the call: both lanes are awaited before any reply
//! (success, failure, deadline or cancel), and every permit, lease and lock
//! belongs to one single-base search, released when it returns or is
//! dropped. The query is never logged or stored.
use crate::{
    LocalPrincipal, Store, StoreError,
    bases::check_input,
    generations::ProfileSnapshot,
    index::IndexEmbedder,
    search::{SearchControl, SearchStage},
};
use kb_client::tools::SearchAll;
use kb_client::{ErrorCode, error::InvalidReason, types::*};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeSet,
};

/// Bases one call searches at once.
pub const SEARCH_ALL_LANES: usize = 2;
/// The local store's "all I can read" limit: the server's default
/// (`SEARCH_ALL_DEFAULT_BASES`, drift-checked in `tests/bases.rs`). Above it,
/// a call without `kbIds` is refused `TOO_MANY_BASES`, never a silent subset.
pub const SEARCH_ALL_LOCAL_BASES: usize = 16;
/// How long the final recheck may spend on recovery the store fence runs,
/// even past the shared deadline (the server's reply reserve is the same 5 s).
const SEARCH_ALL_REPLY_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

/// How one base's turn ended, before the existence rules.
enum Outcome {
    /// Searched; `true` when the keyword arm alone ranked it.
    Searched(SearchOutput, bool),
    /// Settled to a non-searched status that read authorization allowed.
    Status(SearchAllStatus, Option<u64>),
    NotFound,
    /// Not started before the shared deadline.
    NotStarted,
}

impl Store {
    /// `knowledge_search_all` for `p` within the session's KB `selection`
    /// (`kb mcp --kb`; `None` is every KB), embedding through `io`.
    pub async fn search_all(
        &self,
        p: &LocalPrincipal,
        input: SearchAllInput,
        io: IndexEmbedder<'_>,
        ctl: &SearchControl,
        selection: Option<&BTreeSet<String>>,
    ) -> Result<SearchAllOutput, StoreError> {
        self.attach_runtime_cache(&io);
        self.search_all_with(
            p,
            input,
            ctl,
            selection,
            async |one: SearchInput, _: &KbId| self.search_with_mode(p, one, &io, ctl).await,
        )
        .await
    }

    /// Trusted host seam: [`Self::search_all`] with an already admitted
    /// embedder and a per-base stage observer (tests).
    pub async fn search_all_generation(
        &self,
        p: &LocalPrincipal,
        input: SearchAllInput,
        ctl: &SearchControl,
        selection: Option<&BTreeSet<String>>,
        embed: impl AsyncFn(&ProfileSnapshot, &str) -> Result<Vec<f64>, StoreError>,
        observer: &dyn Fn(&KbId, SearchStage) -> Result<(), StoreError>,
    ) -> Result<SearchAllOutput, StoreError> {
        self.search_all_with(
            p,
            input,
            ctl,
            selection,
            async |one: SearchInput, kb: &KbId| {
                self.search_generation_admitted_mode(
                    p,
                    one,
                    ctl,
                    async |pin, text, call| call.run(embed(pin, text)).await,
                    &mut |stage| observer(kb, stage),
                )
                .await
            },
        )
        .await
    }

    async fn search_all_with(
        &self,
        p: &LocalPrincipal,
        input: SearchAllInput,
        ctl: &SearchControl,
        selection: Option<&BTreeSet<String>>,
        run: impl AsyncFn(SearchInput, &KbId) -> Result<(SearchOutput, bool), StoreError>,
    ) -> Result<SearchAllOutput, StoreError> {
        // Whole-call checks before any base: the contract, cancellation and
        // the sensitive-query refusal every base would give.
        check_input::<SearchAll>(&input)?;
        ctl.check()?;
        crate::sensitive_text::prepare_embedding_query(&input.query)?;
        let bases = match &input.kb_ids {
            Some(ids) => {
                let mut seen = BTreeSet::new();
                ids.iter()
                    .filter(|kb| seen.insert(kb.as_str().to_owned()))
                    .cloned()
                    .collect()
            }
            None => {
                // The listing's store fence (and any recovery it runs) stays
                // inside the shared deadline.
                let _deadline = ctl.git_scope();
                self.search_all_listing(p, selection)?
            }
        };
        let limit = search_all_limit_per_base(input.limit_per_base, bases.len());
        let outcomes: RefCell<Vec<Option<Outcome>>> =
            RefCell::new((0..bases.len()).map(|_| None).collect());
        let next = Cell::new(0usize);
        let caller_cancelled = Cell::new(false);
        let whole_call: RefCell<Option<StoreError>> = RefCell::new(None);
        let (bases_ref, outcomes_ref, next_ref, run_ref) = (&bases, &outcomes, &next, &run);
        let (cancelled_ref, whole_ref, query) = (&caller_cancelled, &whole_call, &input.query);
        let lane = || async move {
            loop {
                // A whole-call failure or a cancel starts nothing more.
                if cancelled_ref.get() || whole_ref.borrow().is_some() || ctl.is_cancelled() {
                    return;
                }
                let at = next_ref.get();
                let Some(kb) = bases_ref.get(at) else {
                    return;
                };
                next_ref.set(at + 1);
                let outcome = if ctl.expired() {
                    Outcome::NotStarted
                } else {
                    let attempt = if selection.is_some_and(|kbs| !kbs.contains(kb.as_str())) {
                        // Outside `--kb`: the same not-found as a KB that
                        // does not exist or that this principal cannot read.
                        Err(StoreError::NotFound)
                    } else {
                        let one = SearchInput {
                            kb_id: kb.clone(),
                            query: query.clone(),
                            limit: Some(limit),
                            path_prefix: None,
                            document_id: None,
                        };
                        run_ref(one, kb).await
                    };
                    match attempt {
                        Ok((out, lexical)) => Outcome::Searched(out, lexical),
                        Err(error) => match self.settle_failure(p, kb, selection, ctl, error) {
                            Ok(outcome) => outcome,
                            Err(Settled::Cancelled) => {
                                cancelled_ref.set(true);
                                return;
                            }
                            Err(Settled::WholeCall(error)) => {
                                whole_ref.borrow_mut().get_or_insert(error);
                                return;
                            }
                        },
                    }
                };
                if let Some(slot) = outcomes_ref.borrow_mut().get_mut(at) {
                    *slot = Some(outcome);
                }
            }
        };
        // Both lanes settle before anything is answered.
        const _: () = assert!(SEARCH_ALL_LANES == 2, "one join arm per lane");
        tokio::join!(lane(), lane());
        if let Some(error) = whole_call.into_inner() {
            return Err(error);
        }
        if caller_cancelled.get() || ctl.is_cancelled() {
            return Err(StoreError::OperationAborted(ErrorCode::Cancelled));
        }
        let outcomes = outcomes.into_inner();
        self.search_all_reply(p, selection, ctl, bases, outcomes, limit)
    }

    /// The bases "all I can read" means: exactly the `knowledge_bases_list`
    /// listing of this principal and selection, refused above the limit.
    fn search_all_listing(
        &self,
        p: &LocalPrincipal,
        selection: Option<&BTreeSet<String>>,
    ) -> Result<Vec<KbId>, StoreError> {
        let over = SEARCH_ALL_LOCAL_BASES + 1;
        let page = self.bases_list_selected(
            p,
            BasesListInput {
                limit: Some(over as u64),
                cursor: None,
            },
            selection,
        )?;
        if page.items.len() > SEARCH_ALL_LOCAL_BASES || page.next_cursor.is_some() {
            return Err(StoreError::Invalid {
                reason: InvalidReason::TooManyBases,
                field: None,
                min: None,
                max: Some(SEARCH_ALL_LOCAL_BASES as i64),
                why: format!(
                    "more than {SEARCH_ALL_LOCAL_BASES} readable knowledge bases; pass `kbIds`"
                ),
            });
        }
        Ok(page.items.into_iter().map(|kb| kb.id).collect())
    }

    /// One base's failure as a status. Every status but `not_found` is shown
    /// only while read authority (and the selection) still allows the base,
    /// checked right after the failure; otherwise it is the same `not_found`
    /// a missing base gets.
    fn settle_failure(
        &self,
        p: &LocalPrincipal,
        kb: &KbId,
        selection: Option<&BTreeSet<String>>,
        ctl: &SearchControl,
        error: StoreError,
    ) -> Result<Outcome, Settled> {
        let (status, retry) = match error.protocol_code() {
            ErrorCode::NotFound | ErrorCode::Forbidden => return Ok(Outcome::NotFound),
            ErrorCode::Cancelled if ctl.is_cancelled() => return Err(Settled::Cancelled),
            // Checked for the whole call first; a base cannot differ.
            ErrorCode::SensitiveQuery | ErrorCode::InvalidArgument => {
                return Err(Settled::WholeCall(error));
            }
            ErrorCode::RateLimited => (
                SearchAllStatus::RateLimited,
                Some(match &error {
                    StoreError::RateLimited(seconds) => (*seconds).max(1),
                    _ => 1,
                }),
            ),
            ErrorCode::DeadlineExceeded => (SearchAllStatus::Deadline, None),
            ErrorCode::IndexUnavailable => (SearchAllStatus::Unavailable, None),
            _ => (SearchAllStatus::Unavailable, None),
        };
        if selection.is_some_and(|kbs| !kbs.contains(kb.as_str())) {
            return Ok(Outcome::NotFound);
        }
        // Recovery the fenced recheck may run stays inside the shared
        // deadline (as a single search's final check). A denial is the same
        // not_found a missing base gets; a recheck that could not run (the
        // deadline passed, storage failed) decides nothing: the status stands
        // unverified, skips the diagnostic below, and the final recheck,
        // which every shown row passes, decides.
        let recheck = {
            let _deadline = ctl.git_scope();
            self.reauthorize_read(p, kb)
        };
        match recheck {
            Ok(()) => {}
            Err(denied)
                if matches!(
                    denied.protocol_code(),
                    ErrorCode::NotFound | ErrorCode::Forbidden
                ) =>
            {
                return Ok(Outcome::NotFound);
            }
            Err(_) => return Ok(Outcome::Status(status, retry)),
        }
        if error.protocol_code() == ErrorCode::IndexUnavailable && self.index_rebuilding(kb, ctl) {
            return Ok(Outcome::Status(SearchAllStatus::Rebuilding, None));
        }
        Ok(Outcome::Status(status, retry))
    }

    /// No complete generation to serve while the desired one is pending or
    /// building: the KB's first (or next) build is under way. Two reads of
    /// the registry only (no recovery, no Git), skipped once the shared
    /// deadline passed or the call was cancelled; the caller re-authorized
    /// the base just before, and the final check authorizes it again.
    fn index_rebuilding(&self, kb: &KbId, ctl: &SearchControl) -> bool {
        if ctl.expired() || ctl.is_cancelled() {
            return false;
        }
        let Ok(Some(record)) = self.kb(kb) else {
            return false;
        };
        let active = match &record.active_generation_id {
            Some(id) => match self.generation_state(
                kb,
                "SELECT id, state FROM index_generations WHERE kb_id = ?1 AND id = ?2",
                id.as_str(),
            ) {
                Ok(state) => state.map(|(_, state)| state),
                Err(_) => return false,
            },
            None => None,
        };
        let Ok(desired) = self.generation_state(
            kb,
            "SELECT id, state FROM index_generations WHERE kb_id = ?1 AND epoch = CAST(?2 AS INTEGER) \
             ORDER BY rowid DESC LIMIT 1",
            &record.desired_epoch.to_string(),
        ) else {
            return false;
        };
        let servable =
            record.active_generation_id.is_some() && active == Some(IndexState::Complete);
        !servable
            && matches!(
                desired.map(|(_, state)| state),
                Some(IndexState::Pending | IndexState::Building | IndexState::Indexing)
            )
    }

    /// Final recheck and merge. Every base whose row would not be
    /// `not_found` must still be readable (and selected) now, under one store
    /// fence; one that is not becomes `not_found` and its hits are dropped.
    fn search_all_reply(
        &self,
        p: &LocalPrincipal,
        selection: Option<&BTreeSet<String>>,
        ctl: &SearchControl,
        bases: Vec<KbId>,
        outcomes: Vec<Option<Outcome>>,
        limit: u64,
    ) -> Result<SearchAllOutput, StoreError> {
        // The final recheck runs even past the shared deadline (it is what
        // lets a partial reply out), under its own short bound for any
        // recovery the store fence runs.
        let _reply = ctl.reply_scope(SEARCH_ALL_REPLY_GRACE);
        let guard = self.lock_write(&[])?;
        self.check_guard(&guard)?;
        let mut rows = Vec::with_capacity(bases.len());
        let mut hits: Vec<Vec<CitationHit>> = Vec::with_capacity(bases.len());
        for (kb, outcome) in bases.into_iter().zip(outcomes) {
            let outcome = outcome.unwrap_or(Outcome::NotStarted);
            let readable = !matches!(outcome, Outcome::NotFound)
                && selection.is_none_or(|kbs| kbs.contains(kb.as_str()))
                && self.authorize(p, &kb, Permission::Read).is_ok();
            let (row, found) = match outcome {
                _ if !readable => (not_found_row(kb), Vec::new()),
                Outcome::Searched(out, lexical) => {
                    let found: Vec<CitationHit> =
                        out.results.into_iter().take(limit as usize).collect();
                    (
                        SearchAllBase {
                            kb_id: kb,
                            status: if lexical {
                                SearchAllStatus::LexicalOnly
                            } else {
                                SearchAllStatus::Ok
                            },
                            hit_count: found.len() as u64,
                            generation_id: Some(out.generation_id),
                            freshness: Some(out.freshness),
                            indexed_commit_sha: out.indexed_commit_sha,
                            head_sha: Some(out.head_sha),
                            index_notices: out.index_notices,
                            retry_after_seconds: None,
                        },
                        found,
                    )
                }
                Outcome::Status(status, retry) => (unsearched_row(kb, status, retry), Vec::new()),
                Outcome::NotStarted => (
                    unsearched_row(kb, SearchAllStatus::Deadline, None),
                    Vec::new(),
                ),
                Outcome::NotFound => (not_found_row(kb), Vec::new()),
            };
            rows.push(row);
            hits.push(found);
        }
        drop(guard);
        Ok(SearchAllOutput {
            results: interleave(hits),
            order: RankInterleaved,
            limit_per_base: limit,
            knowledge_bases: rows,
        })
    }
}

/// Why a base ended the whole call instead of giving a row.
enum Settled {
    Cancelled,
    WholeCall(StoreError),
}

/// Every base's rank-1 hit (in row order), then every rank-2 hit, and so on;
/// never ordered by score across bases.
fn interleave(per_base: Vec<Vec<CitationHit>>) -> Vec<SearchAllHit> {
    let depth = per_base.iter().map(Vec::len).max().unwrap_or(0);
    let mut lists: Vec<std::vec::IntoIter<CitationHit>> =
        per_base.into_iter().map(Vec::into_iter).collect();
    let mut merged = Vec::new();
    for rank in 1..=depth {
        for list in &mut lists {
            if let Some(hit) = list.next() {
                merged.push(SearchAllHit {
                    hit,
                    rank: rank as u64,
                });
            }
        }
    }
    merged
}

/// The one row a missing, unreadable or unselected base gets.
fn not_found_row(kb: KbId) -> SearchAllBase {
    unsearched_row(kb, SearchAllStatus::NotFound, None)
}

fn unsearched_row(kb: KbId, status: SearchAllStatus, retry: Option<u64>) -> SearchAllBase {
    SearchAllBase {
        kb_id: kb,
        status,
        hit_count: 0,
        generation_id: None,
        freshness: None,
        indexed_commit_sha: None,
        head_sha: None,
        index_notices: Vec::new(),
        retry_after_seconds: retry.filter(|_| status == SearchAllStatus::RateLimited),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(kb: char, n: u64) -> CitationHit {
        serde_json::from_value(serde_json::json!({
            "knowledgeBaseId": kb.to_string().repeat(24), "knowledgeBaseName": "x",
            "path": format!("d{n}.md"), "documentId": null,
            "commitSha": "0".repeat(40), "blobSha": "0".repeat(40),
            "contentHash": format!("sha256:{}", "0".repeat(64)), "chunkIndex": n,
            "span": {"startToken": 0, "endToken": 1, "startByte": 0, "endByte": 1},
            "snippet": "s", "score": 1.0 / (n as f64 + 1.0), "mode": "hybrid",
            "indexGenerationId": kb.to_string().repeat(24), "freshness": "current",
            "documentCitations": [], "assetRefs": [], "matchedRow": null
        }))
        .expect("hit")
    }

    #[test]
    fn interleaves_by_rank_in_row_order_never_by_score() {
        // Base b's hits all score higher than a's; order still follows rows.
        let a = vec![hit('a', 9), hit('a', 10)];
        let b = vec![hit('b', 0), hit('b', 1), hit('b', 2)];
        let merged = interleave(vec![a, vec![], b]);
        let got: Vec<(String, u64, u64)> = merged
            .iter()
            .map(|h| {
                (
                    h.hit.knowledge_base_id.as_str()[..1].to_owned(),
                    h.hit.chunk_index,
                    h.rank,
                )
            })
            .collect();
        assert_eq!(
            got,
            [
                ("a".into(), 9, 1),
                ("b".into(), 0, 1),
                ("a".into(), 10, 2),
                ("b".into(), 1, 2),
                ("b".into(), 2, 3)
            ]
        );
        assert!(interleave(vec![]).is_empty());
    }

    #[test]
    fn unsearched_rows_carry_nulls_and_retry_only_when_rate_limited() {
        let kb = KbId::parse(&"k".repeat(24)).expect("kb");
        let row = unsearched_row(kb.clone(), SearchAllStatus::Deadline, Some(3));
        assert_eq!(row.retry_after_seconds, None);
        assert!(row.generation_id.is_none() && row.index_notices.is_empty());
        let row = unsearched_row(kb.clone(), SearchAllStatus::RateLimited, Some(3));
        assert_eq!(row.retry_after_seconds, Some(3));
        assert_eq!(
            not_found_row(kb.clone()),
            unsearched_row(kb, SearchAllStatus::NotFound, None)
        );
    }
}
