//! Local kb/1 PR data plane. Store -> sorted KB locks own every read,
//! authority reservation, Git child and finalize. Review never substitutes
//! an unreviewed head. COMMITTING is the durable authority boundary; recovery
//! may finish that reservation after revocation, using its exact PR delta.
use crate::{
    Store, StoreError,
    bases::check_input,
    cursor::{self, Binding},
    diff,
    git_read::GitRepo,
    git_write::{self, MAIN_REF, ObjectWriter, Scratch, TreeEdit},
    journal::{Delta, Observer, Phase, code_from, commit_message, epoch_now, request_hash},
    limits::{RESPONSE_MAX_BYTES, check_response_size, page_limit},
    proposals::{PrRow, ProposalDelta, SELECT_PR, into_row, raw_pr, status_text},
    state::{LocalPrincipal, new_uuid_v4, now_utc},
    tree::{TreeError, validate_commit},
};
use kb_client::types::{
    KbId, Page, Permission, PrMutationOutput, PrStatus, PullRequestsCreate,
    PullRequestsCreateInput, PullRequestsGet, PullRequestsGetInput, PullRequestsGetOutput,
    PullRequestsList, PullRequestsListInput, PullRequestsReview, PullRequestsReviewInput,
    ReviewConfirm, ReviewDecision, Sha, Uuid,
};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};

/// The terminal PR update persisted together with main's journal delta.
pub(crate) struct ReviewDelta {
    pub number: u64,
    pub version: u64,
    pub target: Sha,
    pub merge: Option<Sha>,
}
impl ReviewDelta {
    pub(crate) fn to_json(&self) -> Value {
        json!({"number":self.number,"version":self.version,"target":self.target,"merge":self.merge})
    }
    pub(crate) fn parse(value: &Value) -> Result<Self, StoreError> {
        let bad = || StoreError::RecoveryRequired("review delta".into());
        Ok(Self {
            number: value["number"].as_u64().ok_or_else(bad)?,
            version: value["version"].as_u64().ok_or_else(bad)?,
            target: serde_json::from_value(value["target"].clone()).map_err(|_| bad())?,
            merge: serde_json::from_value(value["merge"].clone()).map_err(|_| bad())?,
        })
    }
}
pub(crate) fn apply_review_delta(
    tx: &rusqlite::Transaction<'_>,
    kb: &KbId,
    delta: &ReviewDelta,
) -> Result<(), StoreError> {
    let changed=tx.execute("UPDATE pull_requests SET status=?3,merge_commit_sha=?4,target_sha=?5,version=version+1,updated_at=?6 WHERE kb_id=?1 AND number=?2 AND version=?7 AND status IN ('OPEN','CONFLICT')",
        rusqlite::params![kb.as_str(),crate::proposals::to_i64(delta.number)?,if delta.merge.is_some(){"MERGED"}else{"CLOSED"},delta.merge.as_ref().map(Sha::as_str),delta.target.as_str(),now_utc(),crate::proposals::to_i64(delta.version)?])?;
    if changed != 1 {
        return Err(StoreError::RecoveryRequired(
            "review row changed at finalize".into(),
        ));
    }
    Ok(())
}
/// Most stale open PRs one list call rechecks before filtering (server parity:
/// `MERGEABILITY_LIST_BUDGET`); past it the page ends early with a cursor.
const LIST_RECHECK_BUDGET: usize = 50;
/// Part of the 30-second PR deadline a list may spend rechecking.
const LIST_RECHECK_TIME: std::time::Duration = std::time::Duration::from_secs(20);
fn request_digest(operation: &str, mut value: Value) -> String {
    if let Some(map) = value.as_object_mut() {
        map.remove("idempotencyKey");
    }
    request_hash(&[operation.as_bytes(), value.to_string().as_bytes()])
}
fn stale(head: &Sha, number: u64) -> StoreError {
    StoreError::StaleBase {
        head_sha: head.clone(),
        proposal_number: Some(number),
    }
}
fn summary_result(op: &Uuid, row: &PrRow) -> PrMutationOutput {
    PrMutationOutput {
        operation_id: op.clone(),
        pr: row.summary(),
    }
}
fn review_permission(
    store: &Store,
    principal: &LocalPrincipal,
    kb: &KbId,
    row: &PrRow,
    decision: ReviewDecision,
) -> Result<(), StoreError> {
    let bits = store.authorize(principal, kb, Permission::Read)?;
    if bits.contains(Permission::Review)
        || (decision == ReviewDecision::Close
            && row.author == principal.actor_key()
            && bits.contains(Permission::Propose))
    {
        Ok(())
    } else {
        Err(StoreError::Forbidden)
    }
}
/// Same complete key as the server's proposals::mergeabilityKey. Local sealed
/// namespaces belong to the immutable store identity (no configured origin).
pub(crate) fn mergeability_key(main: &Sha, generation: i64, row: Option<(&Sha, u64)>) -> String {
    let prefix = format!("v1:{}:{generation}:\"\"", main.as_str());
    match row {
        Some((head, version)) => format!("{prefix}:{}:{version}", head.as_str()),
        None => prefix,
    }
}

impl Store {
    fn pr_main(&self, kb: &KbId) -> Result<(GitRepo, Sha, i64), StoreError> {
        let record = self.active_record(kb)?;
        let main = record
            .head_sha
            .as_deref()
            .and_then(|s| Sha::parse(s).ok())
            .ok_or_else(|| StoreError::RecoveryRequired("active KB head".into()))?;
        let repo = GitRepo::for_kb(&self.paths, kb)?;
        if git_write::read_main(&repo)?.as_ref() != Some(&main) {
            self.mark_repair(kb)?;
            return Err(StoreError::RecoveryRequired(
                "main ref changed outside the store".into(),
            ));
        }
        Ok((repo, main, record.desired_epoch))
    }
    fn check_pr_ref(&self, kb: &KbId, repo: &GitRepo, row: &PrRow) -> Result<(), StoreError> {
        if git_write::read_ref(repo, &row.source_ref)?.as_ref() != Some(&row.head_sha) {
            self.mark_repair(kb)?;
            return Err(StoreError::RecoveryRequired(
                "proposal ref changed outside the store".into(),
            ));
        }
        Ok(())
    }
    fn replay_pr(
        &self,
        actor: &str,
        kb: &KbId,
        operation: &str,
        key: &str,
        digest: &str,
    ) -> Result<Option<PrMutationOutput>, StoreError> {
        let Some(known) = self.find_known(actor, Some(kb), operation, key)? else {
            return Ok(None);
        };
        if known.request_hash != digest {
            return Err(StoreError::IdempotencyMismatch);
        }
        crate::git_read::OperationDeadline::check()?;
        match known.phase {
            Phase::Finalized => serde_json::from_str(known.response.as_deref().unwrap_or(""))
                .map(Some)
                .map_err(|_| StoreError::RecoveryRequired("PR receipt".into())),
            Phase::Aborted => {
                if let Some(conflict) = self.aborted_proposal_conflict(&known.op_id)? {
                    return Err(StoreError::ProposalConflict(conflict));
                }
                Err(StoreError::OperationAborted(code_from(
                    known.failure.as_deref().unwrap_or(""),
                )))
            }
            _ => Err(StoreError::RecoveryRequired("unresolved PR receipt".into())),
        }
    }
    /// The typed refusal an ABORTED merge receipt retained, if any.
    fn aborted_proposal_conflict(
        &self,
        op: &str,
    ) -> Result<Option<Box<kb_client::error::ProposalConflict>>, StoreError> {
        let details: Option<String> = self
            .conn
            .query_row(
                "SELECT failure_details FROM operation_intents WHERE op_id = ?1",
                [op],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        let Some(details) = details else {
            return Ok(None);
        };
        let bad = || StoreError::RecoveryRequired("aborted receipt details".into());
        let details: Value = serde_json::from_str(&details).map_err(|_| bad())?;
        let envelope = kb_client::error::ToolError::from_value(&json!({
            "code": "CONFLICT",
            "message": kb_client::ErrorCode::Conflict.message(),
            "retryable": false,
            "details": details,
        }))
        .map_err(|_| bad())?;
        match envelope.details() {
            kb_client::error::ErrorDetails::ProposalConflict(conflict) => {
                Ok(Some(conflict.clone()))
            }
            _ => Err(bad()),
        }
    }
    pub(crate) fn sealed_policy_generation(&self, kb: &KbId) -> Result<i64, StoreError> {
        Ok(self.conn.query_row(
            "SELECT sealed_policy_generation FROM kbs WHERE id=?1",
            [kb.as_str()],
            |r| r.get(0),
        )?)
    }
    /// An open PR is CONFLICT exactly while it no longer merges into the
    /// current main, OPEN again once it does. The stored status is keyed by
    /// main, PR head/version and sealed-policy generation; stale results use the
    /// reviewed merge's own validated plan and stored for the same head (the
    /// PR's version is left alone). A check that cannot run fails the read:
    /// no read presents an unchecked status as current.
    pub(crate) fn refresh_merge_status(
        &self,
        kb: &KbId,
        repo: &GitRepo,
        guard: &crate::WriteGuard,
        main: &Sha,
        row: &mut PrRow,
    ) -> Result<(), StoreError> {
        let generation = self.sealed_policy_generation(kb)?;
        let key = mergeability_key(main, generation, Some((&row.head_sha, row.version)));
        if !row.is_active() || row.merge_checked_key.as_ref() == Some(&key) {
            return Ok(());
        }
        let dream = row_dream(row)?;
        let status = self.merge_status(
            kb,
            repo,
            guard,
            main,
            &MergeSubject::of(row, dream.as_ref()),
            &[],
            &row.author,
        )?;
        let stored = self.conn.execute(
            "UPDATE pull_requests SET status = ?4, merge_checked_sha = ?5, updated_at = ?6, merge_checked_key = ?7 \
             WHERE kb_id = ?1 AND number = ?2 AND head_sha = ?3 AND status IN ('OPEN', 'CONFLICT')",
            rusqlite::params![
                kb.as_str(),
                crate::proposals::to_i64(row.number)?,
                row.head_sha.as_str(),
                status_text(status),
                main.as_str(),
                now_utc(),
                &key,
            ],
        )?;
        if stored == 1 {
            row.status = status;
            row.merge_checked_sha = Some(main.clone());
            row.merge_checked_key = Some(key);
        }
        Ok(())
    }
    /// Make every open PR a list page could contain current before the
    /// status filter runs: stale open PRs after `after` are rechecked
    /// in number order, at most [`LIST_RECHECK_BUDGET`] per call and within
    /// part of the deadline. Returns the first PR left unchecked, before
    /// which the page must end (its cursor resumes there).
    fn refresh_list_candidates(
        &self,
        kb: &KbId,
        repo: &GitRepo,
        guard: &crate::WriteGuard,
        main: &Sha,
        after: i64,
    ) -> Result<Option<i64>, StoreError> {
        let started = std::time::Instant::now();
        let mut stmt = self.conn.prepare(&format!(
            "{SELECT_PR} WHERE kb_id=?1 AND number>?2 AND status IN ('OPEN','CONFLICT') \
             AND (merge_checked_key IS NULL OR merge_checked_key<>?3 || ':' || head_sha || ':' || version) ORDER BY number LIMIT ?4"
        ))?;
        let stale = stmt
            .query_map(
                rusqlite::params![
                    kb.as_str(),
                    after,
                    mergeability_key(main, self.sealed_policy_generation(kb)?, None),
                    i64::try_from(LIST_RECHECK_BUDGET + 1).unwrap_or(i64::MAX)
                ],
                raw_pr,
            )?
            .map(|r| into_row(r?))
            .collect::<Result<Vec<_>, StoreError>>()?;
        drop(stmt);
        for (checked, mut row) in stale.into_iter().enumerate() {
            if checked == LIST_RECHECK_BUDGET || started.elapsed() >= LIST_RECHECK_TIME {
                return Ok(Some(crate::proposals::to_i64(row.number)?));
            }
            self.refresh_merge_status(kb, repo, guard, main, &mut row)?;
        }
        Ok(None)
    }
    pub fn pull_requests_list(
        &self,
        principal: &LocalPrincipal,
        input: PullRequestsListInput,
    ) -> Result<Page<kb_client::types::PrSummary>, StoreError> {
        let _deadline = crate::git_read::OperationDeadline::start();
        check_input::<PullRequestsList>(&input)?;
        let guard = self.lock_write(std::slice::from_ref(&input.kb_id))?;
        self.authorize(principal, &input.kb_id, Permission::Read)?;
        let (repo, main, _) = self.pr_main(&input.kb_id)?;
        let binding = Binding {
            actor_key: principal.actor_key(),
            kb_id: input.kb_id.as_str().to_owned(),
            filter_hash: cursor::filter_hash(&[
                b"prs",
                input.status.map(status_text).unwrap_or("*").as_bytes(),
            ]),
            sort_key: "pr:number",
        };
        let after = match input.cursor.flatten() {
            Some(token) => cursor::verify(&self.cursor_key, &token, &binding, None, self.now_ms())?
                .last_key
                .ok_or(StoreError::InvalidCursor)?
                .parse::<i64>()
                .map_err(|_| StoreError::InvalidCursor)?,
            None => 0,
        };
        if after < 0 {
            return Err(StoreError::InvalidCursor);
        }
        let limit = page_limit(input.limit)?;
        // Statuses are made current before the filter reads them.
        let stop_before =
            self.refresh_list_candidates(&input.kb_id, &repo, &guard, &main, after)?;
        let mut stmt=self.conn.prepare(&format!("{SELECT_PR} WHERE kb_id=?1 AND number>?2 AND (?3 IS NULL OR status=?3) AND (?5 IS NULL OR number<?5) ORDER BY number LIMIT ?4"))?;
        let rows = stmt.query_map(
            rusqlite::params![
                input.kb_id.as_str(),
                after,
                input.status.map(status_text),
                i64::try_from(limit + 1)
                    .map_err(|_| StoreError::InvalidArgument("limit".into()))?,
                stop_before,
            ],
            raw_pr,
        )?;
        let mut items = rows
            .map(|r| into_row(r?))
            .collect::<Result<Vec<_>, StoreError>>()?;
        let more = items.len() > limit;
        items.truncate(limit);
        // A page cut by the recheck budget resumes at the first unchecked PR.
        let last_key = if more {
            items.last().map(|r| r.number.to_string())
        } else {
            stop_before.map(|n| (n - 1).to_string())
        };
        let next_cursor = last_key
            .map(|key| cursor::sign(&self.cursor_key, &binding, None, key, self.now_ms()))
            .transpose()?;
        let items = items.into_iter().map(|row| row.summary()).collect();
        let result = Page { items, next_cursor };
        self.authorize(principal, &input.kb_id, Permission::Read)?;
        check_response_size(serde_json::to_vec(&result), RESPONSE_MAX_BYTES)?;
        crate::git_read::OperationDeadline::check()?;
        Ok(result)
    }
    pub fn pull_requests_get(
        &self,
        principal: &LocalPrincipal,
        input: PullRequestsGetInput,
    ) -> Result<PullRequestsGetOutput, StoreError> {
        let _deadline = crate::git_read::OperationDeadline::start();
        check_input::<PullRequestsGet>(&input)?;
        let guard = self.lock_write(std::slice::from_ref(&input.kb_id))?;
        self.authorize(principal, &input.kb_id, Permission::Read)?;
        let (repo, main, _) = self.pr_main(&input.kb_id)?;
        let mut row = self
            .pr_row(&input.kb_id, input.number)?
            .ok_or(StoreError::NotFound)?;
        self.check_pr_ref(&input.kb_id, &repo, &row)?;
        let binding = Binding {
            actor_key: principal.actor_key(),
            kb_id: input.kb_id.as_str().to_owned(),
            // Base, head, target and status are pinned in the cursor itself:
            // a PR moved onto main keeps serving its first page's snapshot.
            filter_hash: cursor::filter_hash(&[b"pr:diff", row.number.to_string().as_bytes()]),
            sort_key: "pr:diff",
        };
        let page = input.page.unwrap_or_default();
        let after = if let Some(token) = page.cursor.flatten() {
            let pin = cursor::verify(&self.cursor_key, &token, &binding, None, self.now_ms())?;
            row.head_sha = pin.revision.ok_or(StoreError::InvalidCursor)?;
            let key = pin.last_key.ok_or(StoreError::InvalidCursor)?;
            let mut parts = key.splitn(4, ':');
            let (Some(target), Some(status), Some(base), Some(after)) =
                (parts.next(), parts.next(), parts.next(), parts.next())
            else {
                return Err(StoreError::InvalidCursor);
            };
            row.target_sha = Sha::parse(target).map_err(|_| StoreError::InvalidCursor)?;
            row.base_sha = Sha::parse(base).map_err(|_| StoreError::InvalidCursor)?;
            row.status =
                crate::proposals::parse_status(status).map_err(|_| StoreError::InvalidCursor)?;
            row.merge_checked_sha = None;
            row.merge_checked_key = None;
            Some(after.to_owned())
        } else {
            self.refresh_merge_status(&input.kb_id, &repo, &guard, &main, &mut row)?;
            // One snapshot: the target the status was computed against.
            row.target_sha = row.summary().target_sha;
            row.merge_checked_sha = None;
            row.merge_checked_key = None;
            None
        };
        if input
            .expected_head_sha
            .as_ref()
            .is_some_and(|head| head != &row.head_sha)
        {
            return Err(stale(&row.head_sha, row.number));
        }
        repo.resolve_readable_commit(&row.head_sha)?;
        repo.resolve_readable_commit(&row.base_sha)?;
        self.manifest_entries(&input.kb_id, &repo, &row.base_sha)?;
        self.manifest_entries(&input.kb_id, &repo, &row.head_sha)?;
        let delta = diff::diff_at_revisions(
            &repo,
            &row.base_sha,
            &row.head_sha,
            page_limit(page.limit)?,
            after.as_deref(),
        )?;
        let next_cursor = delta
            .next_after
            .map(|key| {
                cursor::sign(
                    &self.cursor_key,
                    &binding,
                    Some(row.head_sha.clone()),
                    format!(
                        "{}:{}:{}:{key}",
                        row.target_sha,
                        status_text(row.status),
                        row.base_sha
                    ),
                    self.now_ms(),
                )
            })
            .transpose()?;
        let result = PullRequestsGetOutput {
            pr: row.summary(),
            files: delta.files,
            touched_assets: delta.touched_assets,
            next_cursor,
        };
        self.authorize(principal, &input.kb_id, Permission::Read)?;
        check_response_size(serde_json::to_vec(&result), RESPONSE_MAX_BYTES)?;
        crate::git_read::OperationDeadline::check()?;
        Ok(result)
    }
    pub fn pull_requests_create(
        &self,
        principal: &LocalPrincipal,
        input: PullRequestsCreateInput,
    ) -> Result<PrMutationOutput, StoreError> {
        let _deadline = crate::git_read::OperationDeadline::start();
        check_input::<PullRequestsCreate>(&input)?;
        let kb = &input.kb_id;
        let guard = self.lock_write(std::slice::from_ref(kb))?;
        self.authorize(principal, kb, Permission::Propose)?;
        self.active_record(kb)?;
        let actor = principal.actor_key();
        let hash = request_digest(
            "PR_CREATE",
            serde_json::to_value(&input).map_err(|_| StoreError::Internal("PR input".into()))?,
        );
        if let Some(result) = self.replay_pr(
            &actor,
            kb,
            "PR_CREATE",
            input.idempotency_key.as_str(),
            &hash,
        )? {
            return Ok(result);
        }
        crate::uploads::check_mutation_budget(&self.conn, &actor, kb.as_str(), self.now_ms())?;
        self.check_disk_admission(0)?;
        let (repo, main, _) = self.pr_main(kb)?;
        let source = format!("refs/heads/{}", input.head_branch);
        if input.head_branch == "main" || input.head_branch.starts_with("pr/") {
            return Err(StoreError::Forbidden);
        }
        let (valid, _) = repo.run_command(repo.command(["check-ref-format", &source])?, 4096)?;
        if !valid {
            return Err(StoreError::InvalidArgument("branch".into()));
        }
        let owned=self.conn.query_row("SELECT count(*) FROM branch_owners WHERE kb_id=?1 AND ref_name=?2 AND owner_actor_key=?3 AND purpose='USER'",(kb.as_str(),&source,&actor),|r|r.get::<_,i64>(0))?;
        if owned != 1 {
            return Err(StoreError::Forbidden);
        }
        if git_write::read_ref(&repo, &source)?.as_ref() != Some(&input.expected_head_sha)
            || main != input.expected_target_sha
        {
            return Err(stale(&main, self.next_pr_number(kb)?));
        }
        let exists = self
            .conn
            .query_row(
                "SELECT number FROM pull_requests WHERE kb_id=?1 AND source_ref=?2 LIMIT 1",
                (kb.as_str(), &source),
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .is_some();
        if exists {
            return Err(StoreError::Conflict("branch already has a PR".into()));
        }
        let (ok, base) = repo.run_command(
            repo.command([
                "merge-base",
                main.as_str(),
                input.expected_head_sha.as_str(),
            ])?,
            4096,
        )?;
        if !ok {
            return Err(StoreError::Conflict("branches have no common base".into()));
        }
        let base = Sha::parse(String::from_utf8_lossy(&base).trim())
            .map_err(|_| StoreError::Conflict("merge base".into()))?;
        // A receipt never reports an unchecked status.
        let title = input.title.clone();
        let status = self.merge_status(
            kb,
            &repo,
            &guard,
            &main,
            &MergeSubject {
                number: self.next_pr_number(kb)?,
                title: &title,
                head: &input.expected_head_sha,
                pending: &[],
                dream: None,
                prevalidated: None,
            },
            &[],
            &actor,
        )?;
        let delta = ProposalDelta {
            number: self.next_pr_number(kb)?,
            title: input.title,
            author: actor.clone(),
            source_ref: source,
            is_auto: false,
            base_sha: base,
            policy_generation: self.sealed_policy_generation(kb)?,
            target_sha: main,
            version: 1,
            opened: true,
            dream: None,
            status,
            pending: Vec::new(),
        };
        let op = new_uuid_v4()?;
        let result = PrMutationOutput {
            operation_id: op.clone(),
            pr: delta.summary(&input.expected_head_sha),
        };
        let tx = self.conn.unchecked_transaction()?;
        crate::uploads::charge_mutation(&tx, &actor, kb.as_str(), self.now_ms())?;
        crate::git_read::OperationDeadline::check()?;
        crate::proposals::apply_proposal_delta(&tx, kb, &input.expected_head_sha, &delta)?;
        finalized_receipt(
            &tx,
            &op,
            &actor,
            kb,
            "PR_CREATE",
            input.idempotency_key.as_str(),
            &hash,
            &result,
        )?;
        crate::git_read::OperationDeadline::check()?;
        tx.commit()?;
        Ok(result)
    }
    pub fn pull_requests_review(
        &self,
        principal: &LocalPrincipal,
        input: PullRequestsReviewInput,
    ) -> Result<PrMutationOutput, StoreError> {
        self.pull_requests_review_observed(principal, input, &mut |_| Ok(()))
    }
    /// Fault seam at the same publication stages as all local Git writes.
    #[doc(hidden)]
    pub fn pull_requests_review_observed(
        &self,
        principal: &LocalPrincipal,
        input: PullRequestsReviewInput,
        observer: Observer<'_>,
    ) -> Result<PrMutationOutput, StoreError> {
        let _deadline = crate::git_read::OperationDeadline::start();
        check_input::<PullRequestsReview>(&input)?;
        if !matches!(
            (input.decision, input.confirm),
            (ReviewDecision::Merge, ReviewConfirm::Merge)
                | (ReviewDecision::Close, ReviewConfirm::Close)
        ) {
            return Err(StoreError::InvalidArgument(
                "confirm must match decision".into(),
            ));
        }
        let kb = &input.kb_id;
        let guard = self.lock_publication(std::slice::from_ref(kb))?;
        self.authorize(principal, kb, Permission::Read)?;
        self.active_record(kb)?;
        let row = self.pr_row(kb, input.number)?.ok_or(StoreError::NotFound)?;
        review_permission(self, principal, kb, &row, input.decision)?;
        let actor = principal.actor_key();
        let operation = if input.decision == ReviewDecision::Merge {
            "PR_MERGE"
        } else {
            "PR_CLOSE"
        };
        let hash = request_digest(
            operation,
            serde_json::to_value(&input).map_err(|_| StoreError::Internal("PR input".into()))?,
        );
        if let Some(result) =
            self.replay_pr(&actor, kb, operation, input.idempotency_key.as_str(), &hash)?
        {
            return Ok(result);
        }
        crate::uploads::check_mutation_budget(&self.conn, &actor, kb.as_str(), self.now_ms())?;
        self.check_disk_admission(0)?;
        let (repo, main, epoch) = self.pr_main(kb)?;
        self.check_pr_ref(kb, &repo, &row)?;
        if !row.is_active()
            || row.head_sha != input.expected_head_sha
            || main != input.expected_target_sha
        {
            return Err(stale(&row.head_sha, row.number));
        }
        let op = new_uuid_v4()?;
        crate::git_read::OperationDeadline::check()?;
        if input.decision == ReviewDecision::Close {
            let mut closed = row.clone();
            closed.status = PrStatus::Closed;
            closed.version += 1;
            closed.target_sha = main.clone();
            let result = summary_result(&op, &closed);
            let tx = self.conn.unchecked_transaction()?;
            crate::uploads::charge_mutation(&tx, &actor, kb.as_str(), self.now_ms())?;
            apply_review_delta(
                &tx,
                kb,
                &ReviewDelta {
                    number: row.number,
                    version: row.version,
                    target: main,
                    merge: None,
                },
            )?;
            finalized_receipt(
                &tx,
                &op,
                &actor,
                kb,
                operation,
                input.idempotency_key.as_str(),
                &hash,
                &result,
            )?;
            crate::git_read::OperationDeadline::check()?;
            tx.commit()?;
            return Ok(result);
        }
        // Binding carry-in: provenance against current main under the KB lock.
        let dream = row_dream(&row)?;
        let planned = self.plan_merge(
            kb,
            &repo,
            &guard,
            &op,
            &main,
            &MergeSubject::of(&row, dream.as_ref()),
            &[],
            &actor,
            true,
        );
        let (commit, tree, written) = match planned {
            Ok(plan) => plan,
            Err(error) => {
                if error.protocol_code() == kb_client::ErrorCode::Conflict {
                    // A conflict also changes durable PR state. Charge and
                    // retain its terminal failure in the same transaction,
                    // so retrying this key neither rebuilds nor charges again.
                    let tx = self.conn.unchecked_transaction()?;
                    crate::uploads::charge_mutation(&tx, &actor, kb.as_str(), self.now_ms())?;
                    tx.execute("UPDATE pull_requests SET status='CONFLICT',version=version+1,updated_at=?3 WHERE kb_id=?1 AND number=?2 AND status='OPEN'",(kb.as_str(),crate::proposals::to_i64(row.number)?,now_utc()))?;
                    // The typed refusal is replayed with the key (bounded:
                    // at most PROPOSAL_CONFLICT_MAX_PATHS within its budget).
                    let details = matches!(error, StoreError::ProposalConflict(_))
                        .then(|| error.protocol_details().to_string());
                    tx.execute("INSERT INTO operation_intents (op_id,actor_key,kb_id,operation,idempotency_key,request_hash,phase,failure_code,failure_details,created_at,finished_at) VALUES (?1,?2,?3,?4,?5,?6,'ABORTED','CONFLICT',?8,?7,?7)",
                        rusqlite::params![op.as_str(),&actor,kb.as_str(),operation,input.idempotency_key.as_str(),&hash,now_utc(),details])?;
                    tx.commit()?;
                }
                return Err(error);
            }
        };
        let mut merged = row.clone();
        merged.status = PrStatus::Merged;
        merged.merge_commit_sha = Some(commit.clone());
        merged.version += 1;
        merged.target_sha = main.clone();
        let result = summary_result(&op, &merged);
        crate::git_read::OperationDeadline::check()?;
        let delta = Delta {
            head: commit.clone(),
            activate: false,
            updates_main: commit != main,
            desired_epoch: epoch + i64::from(commit != main),
            grant: None,
            proposal: None,
            assets: crate::assets::AssetDelta::default(),
            review: Some(ReviewDelta {
                number: row.number,
                version: row.version,
                target: main.clone(),
                merge: Some(commit.clone()),
            }),
        };
        // Already merged content has no ref effect, but still records MERGED atomically.
        if commit == main {
            let tx = self.conn.unchecked_transaction()?;
            crate::uploads::charge_mutation(&tx, &actor, kb.as_str(), self.now_ms())?;
            apply_review_delta(
                &tx,
                kb,
                delta
                    .review
                    .as_ref()
                    .ok_or_else(|| StoreError::Internal("review delta".into()))?,
            )?;
            finalized_receipt(
                &tx,
                &op,
                &actor,
                kb,
                operation,
                input.idempotency_key.as_str(),
                &hash,
                &result,
            )?;
            crate::git_read::OperationDeadline::check()?;
            tx.commit()?;
            return Ok(result);
        }
        let tx = self.conn.unchecked_transaction()?;
        crate::uploads::charge_mutation(&tx, &actor, kb.as_str(), self.now_ms())?;
        tx.execute("INSERT INTO operation_intents (op_id,actor_key,kb_id,operation,idempotency_key,request_hash,phase,expected_old,intended_new,validated_tree,delta_json,response_json,created_at) VALUES (?1,?2,?3,?4,?5,?6,'PREPARED',?7,?8,?9,?10,?11,?12)",
            rusqlite::params![op.as_str(),actor,kb.as_str(),operation,input.idempotency_key.as_str(),hash,main.as_str(),commit.as_str(),tree.as_str(),delta.to_json(),serde_json::to_string(&result).map_err(|_|StoreError::Internal("PR result".into()))?,now_utc()])?;
        tx.commit()?;
        self.publish_ref(
            &crate::changes::RefPublication {
                guard: &guard,
                repo: &repo,
                principal,
                op_id: &op,
                kb,
                ref_name: MAIN_REF,
                expected_old: Some(&main),
                commit: &commit,
                updates_main: true,
                required: Permission::Review,
                import: None,
                source: Some((&row.source_ref, &row.head_sha)),
            },
            &written,
            &delta,
            observer,
        )?;
        crate::git_read::OperationDeadline::check()?;
        Ok(result)
    }
}
#[allow(clippy::too_many_arguments)] // One receipt identity + its exact response, matching journal insertion.
fn finalized_receipt(
    tx: &rusqlite::Transaction<'_>,
    op: &Uuid,
    actor: &str,
    kb: &KbId,
    operation: &str,
    key: &str,
    hash: &str,
    result: &PrMutationOutput,
) -> Result<(), StoreError> {
    tx.execute("INSERT INTO operation_intents (op_id,actor_key,kb_id,operation,idempotency_key,request_hash,phase,response_json,created_at,finished_at) VALUES (?1,?2,?3,?4,?5,?6,'FINALIZED',?7,?8,?8)",
        rusqlite::params![op.as_str(),actor,kb.as_str(),operation,key,hash,serde_json::to_string(result).map_err(|_|StoreError::Internal("PR result".into()))?,now_utc()])?;
    Ok(())
}
/// What a reviewed merge merges: the PR's identity (for typed refusals and
/// the commit message), its head, recorded conflicts and dream metadata.
pub(crate) struct MergeSubject<'a> {
    pub number: u64,
    pub title: &'a str,
    pub head: &'a Sha,
    pub pending: &'a [crate::pr_merge::ConflictItem],
    /// Persisted dream metadata + guard input; `None` for an ordinary PR.
    pub dream: Option<&'a Value>,
    /// The root tree of `head` when this very operation already validated
    /// `head` with the same policy (pending assets, `main` as base): a
    /// fast-forward merge then needs no second whole-tree walk.
    pub prevalidated: Option<&'a Sha>,
}

impl<'a> MergeSubject<'a> {
    pub(crate) fn of(row: &'a PrRow, dream: Option<&'a Value>) -> Self {
        MergeSubject {
            number: row.number,
            title: &row.title,
            head: &row.head_sha,
            pending: &row.pending_conflicts,
            dream,
            prevalidated: None,
        }
    }
}

/// A PR row's persisted dream metadata.
pub(crate) fn row_dream(row: &PrRow) -> Result<Option<Value>, StoreError> {
    row.dream_metadata
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|_| StoreError::RecoveryRequired("persisted dream metadata".into()))
}

impl Store {
    /// The ONE validated merge plan behind the reviewed merge, every
    /// status a read or receipt reports, and every move onto main's status:
    /// the dream guard against current main, recorded conflicts, the logical
    /// merge (fast-forward when one head contains the other), the merged
    /// commit built as objects, and whole-tree validation with live asset
    /// and sealed-reference policy (`pending_assets` are a publication's own
    /// not-yet-finalized assets). The plan runs in a disposable object
    /// store. For a `review` (a merge that will publish) a refusal is the
    /// typed `PROPOSAL_CONFLICT` when the cause is a set of paths, and the
    /// objects the merge commit needs are promoted into the canonical store
    /// (returned for fsync); a status check leaves the canonical object set
    /// unchanged. Any other failure (Git, storage, deadline) propagates.
    #[allow(clippy::too_many_arguments)] // One plan: store/KB/repo/locks, op identity, subject and policy inputs.
    pub(crate) fn plan_merge(
        &self,
        kb: &KbId,
        repo: &GitRepo,
        guard: &crate::WriteGuard,
        op: &Uuid,
        main: &Sha,
        subject: &MergeSubject<'_>,
        pending_assets: &[crate::tree::ManifestEntry],
        actor: &str,
        review: bool,
    ) -> Result<(Sha, Sha, Vec<String>), StoreError> {
        if let Some(dream) = subject.dream {
            crate::dream::evaluate_merge_guard(repo, main, dream)?;
        }
        // A fast-forward of a head this operation already validated with
        // the same policy needs nothing more: no policy maps, no tree walk.
        if let Some(tree) = subject.prevalidated
            && subject.pending.is_empty()
            && crate::pr_merge::is_ancestor(repo, main, subject.head)?
        {
            return Ok((subject.head.clone(), tree.clone(), Vec::new()));
        }
        let base_tree = TreeEdit::load(repo, main)?;
        let base = base_tree.original_blobs().clone();
        let policy = crate::manifest::Policy {
            store: self,
            kb,
            pending: pending_assets,
            base: Some(&base),
        };
        merged_commit(
            &policy, repo, guard, op, main, subject, actor, review, base_tree,
        )
    }

    /// The status the plan gives: OPEN when it merges, CONFLICT when it is
    /// refused; anything else is an error, never a cached conflict.
    #[allow(clippy::too_many_arguments)] // The plan's inputs.
    pub(crate) fn merge_status(
        &self,
        kb: &KbId,
        repo: &GitRepo,
        guard: &crate::WriteGuard,
        main: &Sha,
        subject: &MergeSubject<'_>,
        pending_assets: &[crate::tree::ManifestEntry],
        actor: &str,
    ) -> Result<PrStatus, StoreError> {
        let op = new_uuid_v4()?;
        match self.plan_merge(
            kb,
            repo,
            guard,
            &op,
            main,
            subject,
            pending_assets,
            actor,
            false,
        ) {
            Ok(_) => Ok(PrStatus::Open),
            Err(error) if error.protocol_code() == kb_client::ErrorCode::Conflict => {
                Ok(PrStatus::Conflict)
            }
            Err(error) => Err(error),
        }
    }
}

/// The reviewed merge: fast-forward when one head contains the other,
/// else the logical three-way merge with main as first parent. A PR with
/// recorded conflicts, or one the logical merge finds conflicts in, is
/// refused with the same typed `PROPOSAL_CONFLICT` details a proposal update
/// gets (plain CONFLICT when not a `review`); the whole result tree is
/// validated either way.
#[allow(clippy::too_many_arguments)] // One merge: policy, repo/locks, op identity and the PR.
fn merged_commit(
    policy: &crate::manifest::Policy<'_>,
    repo: &GitRepo,
    guard: &crate::WriteGuard,
    op: &Uuid,
    main: &Sha,
    subject: &MergeSubject<'_>,
    actor: &str,
    review: bool,
    base_tree: TreeEdit,
) -> Result<(Sha, Sha, Vec<String>), StoreError> {
    let head = subject.head;
    // Every object the plan writes (synthetic trees, merge results, the
    // merged tree and commit) lands in a disposable store; only a review
    // that will publish promotes what the merge commit needs.
    let scratch = Scratch::new(&policy.store.paths, op)?;
    let staged = repo.staged(&scratch.objects_dir()?)?;
    let mut source = crate::pr_merge::GitSource::new(&staged, &policy.store.paths, guard);
    let refuse = |source: &mut crate::pr_merge::GitSource<'_>,
                  paths: &[crate::pr_merge::ConflictItem]|
     -> Result<StoreError, StoreError> {
        if review {
            crate::pr_merge::proposal_conflict_error(source, main, head, subject.number, paths)
        } else {
            Ok(StoreError::Conflict(
                "the pull request conflicts with main".into(),
            ))
        }
    };
    if !subject.pending.is_empty() {
        return Err(refuse(&mut source, subject.pending)?);
    }
    let mut writer = None;
    let commit = if crate::pr_merge::is_ancestor(&staged, main, head)? {
        head.clone()
    } else if crate::pr_merge::is_ancestor(&staged, head, main)? {
        main.clone()
    } else {
        let merged =
            crate::pr_merge::merge_proposal_onto_main(&mut source, main, head, false, &[])?;
        if !merged.conflicts.is_empty() {
            let paths: Vec<_> = merged
                .conflicts
                .iter()
                .map(crate::pr_merge::ConflictItem::from_conflict)
                .collect();
            return Err(refuse(&mut source, &paths)?);
        }
        drop(source);
        let mut built = ObjectWriter::new(&staged, guard, scratch);
        let edit = crate::pr_merge::tree_edit_for(base_tree, &mut built, &merged.tree)?;
        let root = edit.write(&mut built)?;
        // A readable merge commit naming the PR.
        let commit = built.commit_parents(
            &root,
            &[main, head],
            &commit_message(
                &format!("Merge #{}: {}", subject.number, subject.title),
                op,
                actor,
            ),
            epoch_now(),
        )?;
        writer = Some(built);
        commit
    };
    let valid = validate_commit(&staged, &commit, policy).map_err(|e| match e {
        TreeError::Invalid(v) => {
            StoreError::Conflict(format!("merged tree is invalid: {}", v.message))
        }
        TreeError::Git(e) => e.into(),
    })?;
    let written = match (&writer, review) {
        (Some(writer), true) => writer.promote(&commit, &[main, head])?,
        _ => Vec::new(),
    };
    Ok((commit, valid.tree, written))
}

impl Store {
    /// The logical merge of `head` onto `main` as reviewed merges and
    /// statuses run it, for the shared real-Git parity corpus (tests only):
    /// its conflicts and every merged document's bytes.
    #[doc(hidden)]
    #[allow(clippy::type_complexity)] // A test seam: conflicts and documents.
    pub fn logical_merge_for_tests(
        &self,
        kb: &KbId,
        main: &Sha,
        head: &Sha,
    ) -> Result<(Vec<String>, std::collections::BTreeMap<String, Vec<u8>>), StoreError> {
        use crate::logical_merge::MergeSource as _;
        let guard = self.lock_write(std::slice::from_ref(kb))?;
        let repo = GitRepo::for_kb(&self.paths, kb)?;
        let mut source = crate::pr_merge::GitSource::new(&repo, &self.paths, &guard);
        let merged =
            crate::pr_merge::merge_proposal_onto_main(&mut source, main, head, false, &[])?;
        let mut documents = std::collections::BTreeMap::new();
        for (path, blob) in &merged.tree.documents {
            let bytes = match &blob.bytes {
                Some(bytes) => bytes.as_ref().clone(),
                None => source.read(&blob.sha)?,
            };
            documents.insert(path.clone(), bytes);
        }
        Ok((
            merged.conflicts.into_iter().map(|c| c.path).collect(),
            documents,
        ))
    }
}

#[cfg(test)]
mod mergeability_key_tests {
    use super::*;
    #[test]
    fn key_matches_server_and_changes_with_policy_or_heads() {
        let main = Sha::parse(&"a".repeat(40)).unwrap();
        let head = Sha::parse(&"b".repeat(40)).unwrap();
        let key = mergeability_key(&main, 3, Some((&head, 2)));
        assert_eq!(
            key,
            format!("v1:{}:3:\"\":{}:2", main.as_str(), head.as_str())
        );
        assert_ne!(key, mergeability_key(&head, 3, Some((&head, 2))));
        assert_ne!(key, mergeability_key(&main, 4, Some((&head, 2))));
        assert_ne!(key, mergeability_key(&main, 3, Some((&main, 2))));
        assert_ne!(key, mergeability_key(&main, 3, Some((&head, 3))));
    }
}
