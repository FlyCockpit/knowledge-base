//! Task 54 contract-first tests: real Git graphs, live authority, pinned
//! complete diffs and crash-recoverable one-ref merge publication.
#[path = "support/fixture.rs"]
mod fixture;
use fixture::ChildGuard;
#[path = "support/parked_git.rs"]
mod parked_git;

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use base64::{Engine, engine::general_purpose::STANDARD};
use fixture::{Fixture, sha, with_required};
use kb_client::schema::{Direction, validate};
use kb_client::types::*;
use kb_client::{ErrorCode, decode_input};
use kb_local::{LocalPrincipal, Phase, PrincipalKind, Stage, Store, StoreError};
use serde_json::{Value, json};

fn input<T: Tool>(value: Value) -> T::Input {
    decode_input::<T>(value).expect("fixture")
}
fn wire<T: Tool>(value: &T::Output) {
    validate(
        T::NAME.as_str(),
        Direction::Output,
        &serde_json::to_value(value).expect("fixture"),
    )
    .expect("fixture");
}
fn code<T: std::fmt::Debug>(result: Result<T, StoreError>, expected: ErrorCode) {
    assert_eq!(result.expect_err("rejection").protocol_code(), expected);
}
fn edit(op: &str, path: &str, body: &str) -> Value {
    json!([{"op":op,"path":path,"content":{"markdown":body}}])
}
struct Kb {
    store: Store,
    git: Fixture,
    kb: KbId,
    main: Sha,
}
impl Kb {
    fn new(tag: &str) -> Self {
        let mut git = Fixture::new(tag);
        let store = Store::open(&git.root.join("store")).expect("fixture");
        let out = store
            .bases_create(
                &store.owner(),
                input::<BasesCreate>(json!({
                    "name":"PR KB", "slug":"pr", "description":"Pull request fixtures",
                    "idempotencyKey":"create-kb-key-0001"
                })),
            )
            .expect("fixture");
        git.repo = store.paths().repo_dir(&out.kb.id);
        Self {
            store,
            git,
            kb: out.kb.id,
            main: out.kb.head_sha,
        }
    }
    fn principal(&self, bits: &[Permission]) -> LocalPrincipal {
        let guard = self
            .store
            .lock_write(std::slice::from_ref(&self.kb))
            .expect("fixture");
        self.store
            .register_principal(&guard, PrincipalKind::Test, &self.kb, bits)
            .expect("fixture")
    }
    fn epoch(&self) -> i64 {
        self.store.read_kb(&self.kb).expect("fixture").desired_epoch
    }
    fn permissions(&self, who: &LocalPrincipal, bits: &[Permission]) {
        let guard = self
            .store
            .lock_write(std::slice::from_ref(&self.kb))
            .expect("fixture");
        self.store
            .set_principal_permissions(&guard, who, &self.kb, bits)
            .expect("fixture");
    }
    fn head(&self) -> Sha {
        sha(&self.git.git(&["rev-parse", "refs/heads/main"]))
    }
    fn edit(&self, who: &LocalPrincipal, base: &Sha, key: &str, changes: Value) -> ApplyResult {
        self.store
            .changes_apply(
                who,
                input::<ChangesApply>(json!({
                    "kbId":self.kb,"baseRevision":base,"idempotencyKey":key,
                    "mode":"edit","title":"Proposed edits","changes":changes,"sourceSessionIds":[]
                })),
            )
            .expect("fixture")
    }
    fn try_edit(
        &self,
        who: &LocalPrincipal,
        base: &Sha,
        key: &str,
        changes: Value,
        proposal: Option<u64>,
    ) -> Result<ApplyResult, StoreError> {
        let mut body = json!({
            "kbId":self.kb,"baseRevision":base,"idempotencyKey":key,
            "mode":"edit","title":format!("Edit {key}"),"changes":changes,"sourceSessionIds":[]
        });
        if let Some(number) = proposal {
            body["proposalNumber"] = json!(number);
        }
        self.store.changes_apply(who, input::<ChangesApply>(body))
    }
    /// A write naming PR `number` with the PR head it was prepared on.
    fn try_edit_pr(
        &self,
        who: &LocalPrincipal,
        base: &Sha,
        key: &str,
        changes: Value,
        number: u64,
        head: &Sha,
    ) -> Result<ApplyResult, StoreError> {
        self.store.changes_apply(
            who,
            input::<ChangesApply>(json!({
                "kbId":self.kb,"baseRevision":base,"idempotencyKey":key,
                "mode":"edit","title":format!("Edit {key}"),"changes":changes,"sourceSessionIds":[],
                "proposalNumber":number,"proposalHeadSha":head
            })),
        )
    }
    fn list(&self) -> Vec<PrSummary> {
        self.store
            .pull_requests_list(
                &self.store.owner(),
                input::<PullRequestsList>(json!({"kbId":self.kb})),
            )
            .expect("fixture")
            .items
    }
    fn dream(&self, who: &LocalPrincipal, key: &str, body: &str) -> ApplyResult {
        self.store.changes_apply(who,input::<ChangesApply>(json!({
            "kbId":self.kb,"baseRevision":self.main,"idempotencyKey":key,"mode":"dream",
            "title":"dream","changes":[],"sourceSessionIds":["11111111-1111-4111-8111-111111111111"],
            "dream":{"model":{"provider":"test","model":"fixture"},"redactionApplied":true,
            "upserts":[{"id":"concept","type":"concept","title":null,"body":body,"citations":[],"provenance":"dream"}]}
        }))).expect("fixture")
    }
    fn propose(&self, who: &LocalPrincipal, path: &str) -> PrSummary {
        self.edit(
            who,
            &self.main,
            "proposal-key-0001",
            json!([
                {"op":"create","path":path,"content":{"markdown":"proposal\n"}}
            ]),
        )
        .proposal
        .expect("fixture")
    }
    fn review(
        &self,
        who: &LocalPrincipal,
        pr: &PrSummary,
        decision: &str,
        key: &str,
    ) -> Result<PrMutationOutput, StoreError> {
        self.store
            .pull_requests_review(who, self.review_input(pr, decision, key))
    }
    fn review_input(&self, pr: &PrSummary, decision: &str, key: &str) -> PullRequestsReviewInput {
        input::<PullRequestsReview>(json!({
            "kbId":self.kb,"number":pr.number,"decision":decision,
            "expectedHeadSha":pr.head_sha,"expectedTargetSha":pr.target_sha,
            "idempotencyKey":key,"confirm":if decision == "merge" {"MERGE"} else {"CLOSE"}
        }))
    }
    fn get(&self, number: u64, cursor: Option<String>) -> PullRequestsGetOutput {
        self.store
            .pull_requests_get(
                &self.store.owner(),
                input::<PullRequestsGet>(json!({
                    "kbId":self.kb,"number":number,"page":{"limit":50,"cursor":cursor}
                })),
            )
            .expect("fixture")
    }
    fn user_branch(&self, who: &LocalPrincipal, branch: &str, extra: &[(&str, &[u8])]) -> Sha {
        let files = with_required(extra);
        let tree = self.git.tree(&files);
        let head = sha(&self.git.commit(&tree, &[self.main.as_str()]));
        let name = format!("refs/heads/{branch}");
        self.git.set_ref(&name, head.as_str());
        let guard = self
            .store
            .lock_write(std::slice::from_ref(&self.kb))
            .expect("fixture");
        let db = rusqlite::Connection::open(self.store.paths().state_db()).expect("fixture");
        db.execute(
            "INSERT INTO branch_owners VALUES (?1, ?2, ?3, 'USER', 'fixture')",
            (self.kb.as_str(), &name, who.actor_key()),
        )
        .expect("fixture");
        drop(guard);
        head
    }
    fn create_input(&self, branch: &str, head: &Sha, key: &str) -> PullRequestsCreateInput {
        input::<PullRequestsCreate>(json!({
            "kbId":self.kb,"headBranch":branch,"expectedHeadSha":head,
            "expectedTargetSha":self.main,"title":"User branch","idempotencyKey":key
        }))
    }
}

#[test]
fn empty_list_create_owned_user_branch_and_exact_deltas() {
    let k = Kb::new("owned");
    let author = k.principal(&[Permission::Propose]);
    let stranger = k.principal(&[Permission::Propose]);
    let empty = k
        .store
        .pull_requests_list(&author, input::<PullRequestsList>(json!({"kbId":k.kb})))
        .expect("fixture");
    assert!(empty.items.is_empty());
    assert!(empty.next_cursor.is_none());
    wire::<PullRequestsList>(&empty);
    let denied = k.principal(&[]);
    code(
        k.store
            .pull_requests_list(&denied, input::<PullRequestsList>(json!({"kbId":k.kb}))),
        ErrorCode::NotFound,
    );
    code(
        k.store.pull_requests_get(
            &denied,
            input::<PullRequestsGet>(json!({"kbId":k.kb,"number":1})),
        ),
        ErrorCode::NotFound,
    );
    let head = k.user_branch(
        &author,
        "user/topic",
        &[("new.md", b"new"), ("index.md", b"changed")],
    );
    let req = k.create_input("user/topic", &head, "user-pr-key-00001");
    code(
        k.store.pull_requests_create(&stranger, req.clone()),
        ErrorCode::Forbidden,
    );
    k.permissions(&author, &[Permission::Read]);
    code(
        k.store.pull_requests_create(&author, req.clone()),
        ErrorCode::Forbidden,
    );
    assert!(k.store.proposal(&k.kb, 1).expect("fixture").is_none());
    k.permissions(&author, &[Permission::Propose]);
    let mut stale = req.clone();
    stale.expected_head_sha = k.main.clone();
    code(
        k.store.pull_requests_create(&author, stale),
        ErrorCode::Conflict,
    );
    let out = k
        .store
        .pull_requests_create(&author, req.clone())
        .expect("fixture");
    wire::<PullRequestsCreate>(&out);
    assert_eq!(out.pr.source_branch, "user/topic");
    assert_eq!(out.pr.base_sha, k.main);
    assert_eq!(out.pr.author_actor_key, author.actor_key());
    assert_eq!(out.pr.version, 1);
    assert_eq!(
        k.store.pull_requests_create(&author, req).expect("fixture"),
        out
    );
    code(
        k.store.pull_requests_create(
            &author,
            k.create_input("user/topic", &head, "second-pr-key-001"),
        ),
        ErrorCode::Conflict,
    );
    let detail = k.get(out.pr.number, None);
    wire::<PullRequestsGet>(&detail);
    assert_eq!(detail.files.len(), 2);
    assert!(detail.touched_assets.is_empty());
    assert_eq!(detail.files[0].status, FileDeltaStatus::Modified);
    assert!(detail.files[0].before_blob_sha.is_some());
    assert!(detail.files[0].after_blob_sha.is_some());
    assert_eq!(detail.files[1].status, FileDeltaStatus::Added);
    assert!(detail.files[1].before_blob_sha.is_none());
    assert_eq!(k.head(), k.main);
    assert_eq!(k.epoch(), 1);
    // Existing explicit proposal editing must preserve a USER source ref.
    let advanced = k.store.changes_apply(&author, input::<ChangesApply>(json!({
        "kbId":k.kb,"baseRevision":head,"idempotencyKey":"user-advance-001",
        "mode":"edit","title":"Advanced","proposalNumber":out.pr.number,"proposalHeadSha":head,
        "changes":[{"op":"replace","path":"new.md","content":{"markdown":"advanced"}}],"sourceSessionIds":[]
    }))).expect("fixture");
    assert_eq!(
        advanced.proposal.expect("fixture").source_branch,
        "user/topic"
    );
}

#[test]
fn fast_forward_requires_review_confirm_and_replays_durable_sha() {
    let k = Kb::new("ff");
    let author = k.principal(&[Permission::Write]);
    // write doesn't imply review; use propose-only author for the auto branch.
    let proposer = k.principal(&[Permission::Propose]);
    let reviewer = k.principal(&[Permission::Review]);
    let pr = k.propose(&proposer, "topic.md");
    let req = k.review_input(&pr, "merge", "ff-merge-key-001");
    code(
        k.store.pull_requests_review(&author, req.clone()),
        ErrorCode::Forbidden,
    );
    code(
        k.store.pull_requests_review(&proposer, req.clone()),
        ErrorCode::Forbidden,
    );
    let mut invalid = req.clone();
    invalid.confirm = ReviewConfirm::Close;
    code(
        k.store.pull_requests_review(&reviewer, invalid),
        ErrorCode::InvalidArgument,
    );
    assert_eq!(k.head(), k.main);
    assert_eq!(k.epoch(), 1);
    let out = k
        .store
        .pull_requests_review(&reviewer, req.clone())
        .expect("fixture");
    wire::<PullRequestsReview>(&out);
    assert_eq!(out.pr.status, PrStatus::Merged);
    assert_eq!(out.pr.merge_commit_sha, Some(pr.head_sha.clone()));
    assert_eq!(k.head(), pr.head_sha);
    assert_eq!(k.epoch(), 2);
    assert_eq!(
        k.store
            .pull_requests_review(&reviewer, req.clone())
            .expect("fixture"),
        out
    );
    assert_eq!(k.epoch(), 2);
    let guard = k
        .store
        .lock_write(std::slice::from_ref(&k.kb))
        .expect("fixture");
    k.store.compact_receipts(&guard).expect("fixture");
    drop(guard);
    assert_eq!(
        k.store
            .pull_requests_review(&reviewer, req.clone())
            .expect("fixture"),
        out
    );
    k.permissions(&reviewer, &[Permission::Read]);
    code(
        k.store.pull_requests_review(&reviewer, req.clone()),
        ErrorCode::Forbidden,
    );
    k.permissions(&reviewer, &[Permission::Review]);
    let mut mismatch = req.clone();
    mismatch.expected_target_sha = pr.head_sha.clone();
    code(
        k.store.pull_requests_review(&reviewer, mismatch),
        ErrorCode::IdempotencyMismatch,
    );
    k.permissions(&reviewer, &[]);
    code(
        k.store.pull_requests_review(&reviewer, req),
        ErrorCode::NotFound,
    );
    let closed_edit = input::<ChangesApply>(json!({"kbId":k.kb,"baseRevision":pr.head_sha,
        "idempotencyKey":"terminal-edit-001","mode":"edit","title":"no","proposalNumber":pr.number,
        "changes":[{"op":"create","path":"forbidden.md","content":{"markdown":"no"}}],"sourceSessionIds":[]}));
    // The author's own merged PR: the precondition answer (current main).
    code(
        k.store.changes_apply(&proposer, closed_edit),
        ErrorCode::Conflict,
    );
    assert_eq!(
        k.git
            .git(&["rev-parse", &format!("refs/heads/{}", pr.source_branch)]),
        pr.head_sha.as_str()
    );
}

#[test]
fn divergent_merge_has_exactly_two_parents_main_first_and_validates_whole_result() {
    let k = Kb::new("divergent");
    let author = k.principal(&[Permission::Propose]);
    let pr = k.propose(&author, "topic.md");
    let main = k
        .edit(
            &k.store.owner(),
            &k.main,
            "main-update-0001",
            edit("create", "human.md", "human"),
        )
        .commit_sha;
    let viewed = k.get(pr.number, None).pr;
    assert_eq!(viewed.target_sha, main);
    let out = k
        .review(&k.store.owner(), &viewed, "merge", "diverge-merge-01")
        .expect("fixture");
    let merged = out.pr.merge_commit_sha.expect("fixture");
    assert_ne!(merged, pr.head_sha);
    assert_eq!(
        k.git.git(&["show", "-s", "--format=%P", merged.as_str()]),
        format!("{} {}", main, pr.head_sha)
    );
    let paths = k
        .git
        .git(&["ls-tree", "-r", "--name-only", merged.as_str()]);
    assert!(paths.contains("topic.md") && paths.contains("human.md"));
    assert_eq!(k.epoch(), 3);
    // Individually valid trees whose union duplicates a document ID must not publish.
    let k = Kb::new("invalid-union");
    let author = k.principal(&[Permission::Propose]);
    let pr = k
        .edit(
            &author,
            &k.main,
            "duplicate-pr-001",
            edit("create", "a.md", "---\nid: same\n---\na"),
        )
        .proposal
        .expect("fixture");
    let main = k
        .edit(
            &k.store.owner(),
            &k.main,
            "duplicate-main-1",
            edit("create", "b.md", "---\nid: same\n---\nb"),
        )
        .commit_sha;
    // The duplicate id is a typed logical conflict, so the PR reads
    // CONFLICT and the merge is refused with both paths' versions.
    let viewed = k.get(pr.number, None).pr;
    assert_eq!(viewed.status, PrStatus::Conflict);
    assert_eq!(viewed.target_sha, main);
    match k.review(&k.store.owner(), &viewed, "merge", "invalid-merge-01") {
        Err(StoreError::ProposalConflict(conflict)) => {
            assert_eq!(conflict.head_sha, main);
            assert_eq!(conflict.proposal_number, Some(pr.number as i64));
            let paths: Vec<_> = conflict.paths.iter().map(|p| p.path.as_str()).collect();
            assert_eq!(paths, ["a.md", "b.md"]);
            assert!(conflict.content_included);
            let error = StoreError::ProposalConflict(conflict);
            assert_eq!(error.protocol_code(), ErrorCode::Conflict);
            assert_eq!(error.protocol_details()["reason"], "PROPOSAL_CONFLICT");
        }
        other => panic!("expected PROPOSAL_CONFLICT, got {other:?}"),
    }
    assert_eq!(k.head(), main);
    assert_eq!(k.epoch(), 2);
}

#[test]
fn stale_source_or_target_and_true_conflicts_never_move_main() {
    let k = Kb::new("stale");
    let author = k.principal(&[Permission::Propose]);
    let pr = k.propose(&author, "topic.md");
    let req = k.review_input(&pr, "merge", "stale-source-001");
    let advanced = k
        .try_edit_pr(
            &author,
            &pr.head_sha,
            "advance-key-0010",
            edit("replace", "topic.md", "advanced"),
            pr.number,
            &pr.head_sha,
        )
        .expect("explicit update")
        .proposal
        .expect("fixture");
    let stale = k
        .store
        .pull_requests_review(&k.store.owner(), req)
        .expect_err("stale source");
    assert_eq!(stale.protocol_code(), ErrorCode::Conflict);
    assert_eq!(
        stale.protocol_details()["headSha"],
        advanced.head_sha.as_str()
    );
    let stale_target = k.review_input(&advanced, "merge", "stale-target-001");
    let main = k
        .edit(
            &k.store.owner(),
            &k.main,
            "stale-main-00010",
            edit("create", "main.md", "main"),
        )
        .commit_sha;
    code(
        k.store.pull_requests_review(&k.store.owner(), stale_target),
        ErrorCode::Conflict,
    );
    assert_eq!(k.head(), main);
    let k = Kb::new("conflict");
    let author = k.principal(&[Permission::Propose]);
    let pr = k
        .edit(
            &author,
            &k.main,
            "conflicting-pr-1",
            edit("replace", "index.md", "proposal"),
        )
        .proposal
        .expect("fixture");
    let main = k
        .edit(
            &k.store.owner(),
            &k.main,
            "conflicting-main",
            edit("replace", "index.md", "human"),
        )
        .commit_sha;
    let review = k.review_input(&k.get(pr.number, None).pr, "merge", "conflict-merge-01");
    let db = rusqlite::Connection::open(k.store.paths().state_db()).expect("db");
    let charges = || {
        db.query_row("SELECT json_array_length(times_json) FROM mutation_windows WHERE actor_key=?1 AND kb_id=?2",
        (k.store.owner().actor_key(),k.kb.as_str()),|r|r.get::<_,i64>(0)).expect("charges")
    };
    let before = charges();
    code(
        k.store
            .pull_requests_review(&k.store.owner(), review.clone()),
        ErrorCode::Conflict,
    );
    assert_eq!(
        charges(),
        before + 1,
        "conflict state and terminal failure share charge"
    );
    code(
        k.store.pull_requests_review(&k.store.owner(), review),
        ErrorCode::Conflict,
    );
    assert_eq!(charges(), before + 1, "conflict replay is free");
    assert_eq!(k.head(), main);
    assert_eq!(k.epoch(), 2);
    assert_eq!(k.get(pr.number, None).pr.status, PrStatus::Conflict);
}

#[test]
fn close_requires_reviewer_or_author_with_current_propose_and_retains_branch() {
    let k = Kb::new("close");
    let author = k.principal(&[Permission::Propose]);
    let other = k.principal(&[Permission::Propose]);
    let pr = k.propose(&author, "topic.md");
    let req = k.review_input(&pr, "close", "close-key-000010");
    code(
        k.store.pull_requests_review(&other, req.clone()),
        ErrorCode::Forbidden,
    );
    k.permissions(&author, &[Permission::Read]);
    code(
        k.store.pull_requests_review(&author, req.clone()),
        ErrorCode::Forbidden,
    );
    k.permissions(&author, &[Permission::Propose]);
    let out = k
        .store
        .pull_requests_review(&author, req.clone())
        .expect("fixture");
    assert_eq!(out.pr.status, PrStatus::Closed);
    assert!(out.pr.merge_commit_sha.is_none());
    wire::<PullRequestsReview>(&out);
    assert_eq!(
        k.store.pull_requests_review(&author, req).expect("fixture"),
        out
    );
    assert_eq!(k.head(), k.main);
    assert_eq!(k.epoch(), 1);
    assert_eq!(
        k.git
            .git(&["rev-parse", &format!("refs/heads/{}", pr.source_branch)]),
        pr.head_sha.as_str()
    );
    let guard = k
        .store
        .lock_write(std::slice::from_ref(&k.kb))
        .expect("fixture");
    code(
        k.store
            .set_proposal_status_for_tests(&guard, &k.kb, pr.number, PrStatus::Open),
        ErrorCode::Conflict,
    );
    drop(guard);
    let next = k
        .edit(
            &author,
            &k.main,
            "next-proposal-01",
            edit("create", "next.md", "next"),
        )
        .proposal
        .expect("fixture");
    assert_eq!(next.number, pr.number + 1);
    let reviewer = k.principal(&[Permission::Review]);
    k.review(&reviewer, &next, "close", "reviewer-close-1")
        .expect("fixture");
    let page = k
        .store
        .pull_requests_list(
            &author,
            input::<PullRequestsList>(json!({"kbId":k.kb,"status":"CLOSED","limit":1})),
        )
        .expect("fixture");
    assert_eq!(page.items.len(), 1);
    assert!(page.next_cursor.is_some());
    wire::<PullRequestsList>(&page);
    let next_page = k
        .store
        .pull_requests_list(
            &author,
            input::<PullRequestsList>(
                json!({"kbId":k.kb,"status":"CLOSED","limit":1,"cursor":page.next_cursor}),
            ),
        )
        .expect("fixture");
    assert_eq!(next_page.items[0].number, next.number);
    assert!(next_page.next_cursor.is_none());
}

#[test]
fn late_human_provenance_conflicts_even_when_git_can_merge_cleanly() {
    let mut k = Kb::new("dream");
    k.main = k
        .dream(
            &k.store.owner(),
            "seed-dream-key001",
            &format!("{}old\n", "context\n".repeat(8)),
        )
        .commit_sha;
    let author = k.principal(&[Permission::Propose]);
    let pr = k
        .dream(
            &author,
            "dream-proposal-01",
            &format!("{}new\n", "context\n".repeat(8)),
        )
        .proposal
        .expect("fixture");
    // Legitimate dream proposals merge; a provenance-only edit is a clean
    // Git merge but must still fail the domain guard after a reopen.
    let root = k.store.paths().root().to_owned();
    let reopened = Store::open(&root).expect("fixture");
    let source = k
        .git
        .git(&["show", &format!("{}:concepts/concept.md", k.main)]);
    let main = k.edit(&reopened.owner(), &k.main, "human-after-dream", json!([
        {"op":"replace","path":"concepts/concept.md","content":{"markdown":format!("{}\n",source.replace("provenance: dream","provenance: human"))}}
    ])).commit_sha;
    k.git.git(&[
        "merge-tree",
        "--write-tree",
        "--no-messages",
        main.as_str(),
        pr.head_sha.as_str(),
    ]);
    code(
        reopened.pull_requests_review(
            &reopened.owner(),
            k.review_input(&k.get(pr.number, None).pr, "merge", "dream-merge-key01"),
        ),
        ErrorCode::Conflict,
    );
    assert_eq!(k.head(), main);
    assert_eq!(k.epoch(), 3);
}

#[test]
fn complete_large_diff_and_assets_pin_both_manifests_and_cursor_identity() {
    let k = Kb::new("pagination");
    let author = k.principal(&[Permission::Propose]);
    let names: Vec<_> = (0..211).map(|n| format!("docs/{n:03}.md")).collect();
    let mut extra: Vec<_> = names
        .iter()
        .map(|p| (p.as_str(), b"doc".as_slice()))
        .collect();
    // Publish a real READY asset proposal to establish permanent local lineage.
    // Its separate PR leaves the original main/base snapshot empty.
    let shared = include_str!("../../../../../packages/api/src/lib/kb/fixtures/media-bytes.ts");
    let encoded = shared
        .split("export function minimalPng(): Buffer {")
        .nth(1)
        .expect("shared fixture")
        .split('"')
        .nth(1)
        .expect("PNG fixture");
    let bytes = STANDARD.decode(encoded).expect("PNG bytes");
    let hash = kb_client::snapshot::content_hash(&bytes);
    let upload = k
        .store
        .upload_begin(
            &author,
            input::<UploadBegin>(json!({
                "kbId":k.kb,"kind":"asset","size":bytes.len(),"contentHash":hash,
                "mime":"image/png","idempotencyKey":"large-asset-upload-01"
            })),
        )
        .expect("staging");
    k.store
        .upload_write(
            &author,
            input::<UploadWrite>(
                json!({"kbId":k.kb,"uploadId":upload.upload_id,"offset":0,"bytesBase64":encoded}),
            ),
        )
        .expect("frame");
    k.store
        .upload_finish(
            &author,
            input::<UploadFinish>(json!({"kbId":k.kb,"uploadId":upload.upload_id})),
        )
        .expect("READY");
    k.store.assets_put(&author,input::<AssetsPut>(json!({"kbId":k.kb,"baseRevision":k.main,"idempotencyKey":"large-asset-put-01","path":"media/photo.png","uploadId":upload.upload_id}))).expect("lineage");
    let manifest = kb_local::tree::canonical_manifest_bytes(&[kb_local::tree::ManifestEntry {
        path: "media/photo.png".into(),
        hash: hash.as_str().into(),
        size: bytes.len() as u64,
        mime: "image/png".into(),
    }]);
    extra.push((".assets/manifest.json", &manifest));
    let head = k.user_branch(&author, "user/large", &extra);
    let out = k
        .store
        .pull_requests_create(
            &author,
            k.create_input("user/large", &head, "large-pr-key-001"),
        )
        .expect("fixture");
    let first = k.get(out.pr.number, None);
    wire::<PullRequestsGet>(&first);
    assert_eq!(first.files.len() + first.touched_assets.len(), 50);
    let asset = &first.touched_assets[0];
    assert!(asset.before.is_none());
    assert_eq!(
        asset.after.as_ref().expect("fixture").size,
        bytes.len() as u64
    );
    let cursor = first.next_cursor.clone().expect("fixture");
    k.edit(
        &k.store.owner(),
        &k.main,
        "advance-main-0010",
        edit("create", "main-later.md", "later"),
    );
    let foreign = k.principal(&[Permission::Read]);
    code(
        k.store.pull_requests_get(
            &foreign,
            input::<PullRequestsGet>(
                json!({"kbId":k.kb,"number":out.pr.number,"page":{"cursor":cursor}}),
            ),
        ),
        ErrorCode::InvalidCursor,
    );
    let mut tampered = cursor.clone();
    tampered.replace_range(0..1, "!");
    code(
        k.store.pull_requests_get(
            &k.store.owner(),
            input::<PullRequestsGet>(
                json!({"kbId":k.kb,"number":out.pr.number,"page":{"cursor":tampered}}),
            ),
        ),
        ErrorCode::InvalidCursor,
    );
    // Advance source through the existing journal. Subsequent pages still show the reviewed head.
    k.store
        .changes_apply(
            &author,
            input::<ChangesApply>(
                json!({"kbId":k.kb,"baseRevision":head,"proposalNumber":out.pr.number,
        "idempotencyKey":"large-advance-01","mode":"edit","title":"new head","sourceSessionIds":[],
        "changes":[{"op":"create","path":"later.md","content":{"markdown":"later"}}]}),
            ),
        )
        .expect("advance authorized proposal");
    let mut files = first.files;
    let mut assets = first.touched_assets;
    let mut next = Some(cursor);
    while let Some(token) = next {
        let page = k.get(out.pr.number, Some(token));
        wire::<PullRequestsGet>(&page);
        assert_eq!(page.pr.head_sha, head);
        assert_eq!(page.pr.base_sha, k.main);
        assert_eq!(page.pr.target_sha, k.main);
        assert!(page.files.len() + page.touched_assets.len() <= 200);
        files.extend(page.files);
        assets.extend(page.touched_assets);
        next = page.next_cursor;
    }
    assert_eq!(files.len(), 213);
    assert_eq!(assets.len(), 1);
    assert!(!files.iter().any(|d| d.path.as_str() == "later.md"));
    let paths: std::collections::BTreeSet<_> = files.iter().map(|d| d.path.as_str()).collect();
    assert_eq!(paths.len(), 213);
    code(
        k.store.pull_requests_get(
            &k.store.owner(),
            input::<PullRequestsGet>(
                json!({"kbId":k.kb,"number":out.pr.number,"expectedHeadSha":head}),
            ),
        ),
        ErrorCode::Conflict,
    );
}

#[test]
fn revocation_before_reservation_denies_but_after_reservation_finishes_once() {
    for (stage, succeeds) in [(Stage::Prepared, false), (Stage::Committing, true)] {
        let k = Kb::new("revoke");
        let author = k.principal(&[Permission::Propose]);
        let reviewer = k.principal(&[Permission::Review]);
        let pr = k.propose(&author, "topic.md");
        let req = k.review_input(&pr, "merge", "revoke-merge-001");
        let result = k
            .store
            .pull_requests_review_observed(&reviewer, req.clone(), &mut |at| {
                if at == stage {
                    // Same-lock authority mutation, exactly at the reservation boundary.
                    rusqlite::Connection::open(k.store.paths().state_db()).expect("fixture").execute(
                    "UPDATE principal_ceilings SET bits=1 WHERE principal_id=?1 AND kb_id=?2",
                    (reviewer.id(),k.kb.as_str())).expect("fixture");
                }
                Ok(())
            });
        if succeeds {
            assert_eq!(result.expect("fixture").pr.status, PrStatus::Merged);
            assert_eq!(k.head(), pr.head_sha);
            assert_eq!(k.epoch(), 2);
        } else {
            code(result, ErrorCode::Forbidden);
            assert_eq!(k.head(), k.main);
            assert_eq!(k.epoch(), 1);
        }
        code(
            k.store.pull_requests_review(&reviewer, req),
            ErrorCode::Forbidden,
        );
    }
}

#[test]
fn child_merge_entry() {
    let Ok(root) = std::env::var("KB_PR_CHILD_ROOT") else {
        return;
    };
    let store = Store::open(std::path::Path::new(&root)).expect("fixture");
    let kb = KbId::parse(&std::env::var("KB_PR_CHILD_ID").expect("fixture")).expect("fixture");
    let at = std::env::var("KB_PR_CHILD_STAGE").expect("fixture");
    let pr = store.proposal(&kb, 1).expect("fixture").expect("fixture");
    let req = input::<PullRequestsReview>(json!({"kbId":kb,"number":1,"decision":"merge",
        "expectedHeadSha":pr.head_sha,"expectedTargetSha":pr.target_sha,"idempotencyKey":"crash-merge-key1","confirm":"MERGE"}));
    store
        .pull_requests_review_observed(&store.owner(), req, &mut |stage| {
            if format!("{stage:?}") == at {
                writeln!(std::io::stdout(), "PARKED").expect("barrier");
                std::io::stdout().flush().expect("fixture");
                loop {
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
            Ok(())
        })
        .expect("fixture");
}

#[test]
fn interrupted_merge_recovers_one_effect_and_index_intent() {
    for stage in [
        Stage::Prepared,
        Stage::Committing,
        Stage::RefMoved,
        Stage::Finalizing,
        Stage::Finalized,
    ] {
        let k = Kb::new("crash");
        let author = k.principal(&[Permission::Propose]);
        let pr = k.propose(&author, "topic.md");
        let mut child = ChildGuard::spawn(
            Command::new(std::env::current_exe().expect("fixture"))
                .args(["--exact", "child_merge_entry", "--nocapture"])
                .env("KB_PR_CHILD_ROOT", k.store.paths().root())
                .env("KB_PR_CHILD_ID", k.kb.as_str())
                .env("KB_PR_CHILD_STAGE", format!("{stage:?}"))
                .stdout(Stdio::piped())
                .stderr(Stdio::piped()),
        )
        .expect("fixture");
        let stdout = child.stdout.take().expect("fixture");
        let (send, recv) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if line.expect("fixture").contains("PARKED") {
                    let _ = send.send(());
                    break;
                }
            }
        });
        let started = Instant::now();
        let parked = recv.recv_timeout(Duration::from_secs(15));
        assert!(
            k.store
                .try_lock_write(std::slice::from_ref(&k.kb))
                .expect("fixture")
                .is_none()
        );
        child.kill().expect("fixture");
        let output = child.wait_with_output().expect("fixture");
        reader.join().expect("fixture");
        assert!(
            parked.is_ok(),
            "failed to park at {stage:?} after {:?}: {}",
            started.elapsed(),
            String::from_utf8_lossy(&output.stderr)
        );
        let recovered = Store::open(k.store.paths().root()).expect("fixture");
        // Open may defer recovery if its nonblocking admission is busy.
        let record = recovered.read_kb(&k.kb).expect("read-only recovery gate");
        let published = matches!(
            stage,
            Stage::RefMoved | Stage::Finalizing | Stage::Finalized
        );
        let row = recovered
            .proposal(&k.kb, pr.number)
            .expect("fixture")
            .expect("fixture");
        assert_eq!(
            row.status,
            if published {
                PrStatus::Merged
            } else {
                PrStatus::Open
            }
        );
        assert_eq!(
            k.head(),
            if published {
                pr.head_sha.clone()
            } else {
                k.main.clone()
            }
        );
        assert_eq!(record.desired_epoch, if published { 2 } else { 1 });
        let intent = recovered
            .intents(&k.kb)
            .expect("fixture")
            .into_iter()
            .filter(|r| r.operation == "PR_MERGE")
            .collect::<Vec<_>>();
        assert_eq!(intent.len(), 1);
        assert_eq!(
            intent[0].phase,
            if published {
                Phase::Finalized
            } else {
                Phase::Aborted
            }
        );
        let retry = recovered.pull_requests_review(
            &recovered.owner(),
            k.review_input(&pr, "merge", "crash-merge-key1"),
        );
        if published {
            assert_eq!(
                retry.expect("fixture").pr.merge_commit_sha,
                Some(pr.head_sha)
            );
        } else {
            code(retry, ErrorCode::Conflict);
        }
        assert_eq!(
            recovered.read_kb(&k.kb).expect("fixture").desired_epoch,
            if published { 2 } else { 1 }
        );
    }
}

#[test]
fn deltas_include_deletions_and_asset_replacements_at_two_manifests() {
    let f = Fixture::new("asset-diff");
    let asset = |path: &str, hash: &str| json!({"path":path,"hash":format!("sha256:{}",hash.repeat(64)),"size":5,"mime":"image/png"});
    let before=json!({"version":1,"entries":[asset("media/change.png","a"),asset("media/delete.png","b")]}).to_string();
    let after =
        json!({"version":1,"entries":[asset("media/add.png","c"),asset("media/change.png","d")]})
            .to_string();
    let base = sha(&f.commit_files(
        &with_required(&[
            (".assets/manifest.json", before.as_bytes()),
            ("old.md", b"old"),
        ]),
        &[],
    ));
    let names: Vec<_> = (0..205).map(|n| format!("new/{n:03}.md")).collect();
    let mut files: Vec<_> = names
        .iter()
        .map(|p| (p.as_str(), b"new".as_slice()))
        .collect();
    files.push((".assets/manifest.json", after.as_bytes()));
    let head = sha(&f.commit_files(&with_required(&files), &[base.as_str()]));
    let repo = kb_local::git_read::GitRepo::open(&f.repo).expect("fixture");
    let first =
        kb_local::diff::diff_at_revisions(&repo, &base, &head, usize::MAX, None).expect("fixture");
    assert_eq!(first.files.len() + first.touched_assets.len(), 200);
    assert_eq!(first.touched_assets.len(), 3);
    assert!(first.touched_assets[0].before.is_none());
    assert_ne!(
        first.touched_assets[1].before,
        first.touched_assets[1].after
    );
    assert!(first.touched_assets[2].after.is_none());
    let second =
        kb_local::diff::diff_at_revisions(&repo, &base, &head, 200, first.next_after.as_deref())
            .expect("fixture");
    assert!(second.next_after.is_none());
    assert_eq!(first.files.len() + second.files.len(), 207);
    let deleted = second
        .files
        .iter()
        .find(|d| d.path.as_str() == "old.md")
        .expect("fixture");
    assert_eq!(deleted.status, FileDeltaStatus::Deleted);
    assert_eq!(deleted.before_blob_sha, Some(sha(&f.blob(b"old"))));
    assert!(deleted.after_blob_sha.is_none());
}

#[test]
fn legitimate_dream_and_already_integrated_source_can_be_reviewed_without_extra_epoch() {
    let mut k = Kb::new("inverse");
    let author = k.principal(&[Permission::Propose]);
    let pr = k
        .dream(&author, "clean-dream-key01", "safe\n")
        .proposal
        .expect("fixture");
    let out = k
        .review(&k.store.owner(), &pr, "merge", "clean-dream-merge")
        .expect("fixture");
    assert_eq!(out.pr.merge_commit_sha, Some(pr.head_sha));
    assert_eq!(k.epoch(), 2);
    k.main = k.head();
    let a = k.user_branch(&author, "user/first", &[("next.md", b"next")]);
    let b = k.user_branch(&author, "user/second", &[("next.md", b"next")]);
    assert_eq!(a, b);
    let first = k
        .store
        .pull_requests_create(
            &author,
            k.create_input("user/first", &a, "ancestor-first01"),
        )
        .expect("fixture")
        .pr;
    let second = k
        .store
        .pull_requests_create(
            &author,
            k.create_input("user/second", &b, "ancestor-second1"),
        )
        .expect("fixture")
        .pr;
    k.review(&k.store.owner(), &first, "merge", "ancestor-merge01")
        .expect("fixture");
    let epoch = k.epoch();
    let out = k
        .review(
            &k.store.owner(),
            &k.get(second.number, None).pr,
            "merge",
            "ancestor-merge02",
        )
        .expect("fixture");
    assert_eq!(out.pr.merge_commit_sha, Some(b));
    assert_eq!(k.head(), a);
    assert_eq!(k.epoch(), epoch);
}

// These children exercise actual OS admission/Git supervision, not mock ports.
struct PolicyChild {
    child: ChildGuard,
    lines: std::sync::mpsc::Receiver<String>,
    reader: Option<std::thread::JoinHandle<()>>,
    method_elapsed: std::cell::Cell<Option<u128>>,
}
impl PolicyChild {
    fn new(k: &Kb, role: &str, request: Value, path: Option<&str>) -> Self {
        let mut cmd = Command::new(std::env::current_exe().expect("fixture"));
        cmd.args([
            "--exact",
            "child_policy_entry",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("KB_PR_POLICY_ROOT", k.store.paths().root())
        .env("KB_PR_POLICY_ROLE", role)
        .env("KB_PR_POLICY_REQUEST", request.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
        if let Some(path) = path {
            cmd.env("PATH", path);
        }
        let mut child = ChildGuard::spawn(&cmd).expect("fixture");
        let stdout = child.stdout.take().expect("fixture");
        let (send, lines) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let _ = send.send(line.expect("child stdout"));
            }
        });
        let child = Self {
            child,
            lines,
            reader: Some(reader),
            method_elapsed: std::cell::Cell::new(None),
        };
        child.wait("READY", Duration::from_secs(15));
        child
    }
    fn wait(&self, prefix: &str, timeout: Duration) -> String {
        let end = Instant::now() + timeout;
        loop {
            let line = self
                .lines
                .recv_timeout(end.saturating_duration_since(Instant::now()))
                .expect("child boundary timed out");
            if line.starts_with(prefix) {
                if prefix == "RESULT:" {
                    let (result, elapsed) = line.rsplit_once(':').expect("method duration frame");
                    self.method_elapsed
                        .set(Some(elapsed.parse().expect("method duration")));
                    return result.to_owned();
                }
                return line;
            }
        }
    }
    fn method_elapsed_ms(&self) -> u128 {
        // The result and owner measurement share one frame: no second receive
        // deadline can race a descheduled child after its method has returned.
        self.method_elapsed
            .get()
            .expect("method duration from result")
    }
    fn start(&mut self) {
        self.method_elapsed.set(None);
        writeln!(self.child.stdin.as_mut().expect("fixture"), "go").expect("fixture");
    }
}
impl Drop for PolicyChild {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.child.drain().expect("drain policy writer tree");
        if let Some(reader) = self.reader.take() {
            reader.join().expect("fixture");
        }
    }
}
#[test]
fn child_policy_entry() {
    let Ok(root) = std::env::var("KB_PR_POLICY_ROOT") else {
        return;
    };
    let store = Store::open(std::path::Path::new(&root)).expect("fixture");
    let role = std::env::var("KB_PR_POLICY_ROLE").expect("fixture");
    let request: Value =
        serde_json::from_str(&std::env::var("KB_PR_POLICY_REQUEST").expect("fixture"))
            .expect("fixture");
    // Libtest's serial runner prints `test child_policy_entry ... ` without
    // a newline. Keep our first protocol frame on its own line, as the
    // lock/recovery child fixtures do, rather than depending on thread count.
    writeln!(std::io::stdout(), "\nREADY").expect("barrier");
    std::io::stdout().flush().expect("barrier");
    std::io::stdin()
        .read_line(&mut String::new())
        .expect("fixture");
    let who = store.owner();
    let retry_request = request.clone();
    let method_started = Instant::now();
    let result = match role.as_str() {
        "list" => store
            .pull_requests_list(&who, input::<PullRequestsList>(request))
            .map(|_| ()),
        "get" => store
            .pull_requests_get(&who, input::<PullRequestsGet>(request))
            .map(|_| ()),
        "create" => store
            .pull_requests_create(&who, input::<PullRequestsCreate>(request))
            .map(|_| ()),
        _ => store
            .pull_requests_review(&who, input::<PullRequestsReview>(request))
            .map(|_| ()),
    };
    let method_elapsed_ms = method_started.elapsed().as_millis();
    writeln!(
        std::io::stdout(),
        "RESULT:{}:{method_elapsed_ms}",
        result.map_or_else(|e| e.protocol_code().as_str(), |()| "OK")
    )
    .expect("barrier");
    if role == "review-reentry" {
        std::io::stdin()
            .read_line(&mut String::new())
            .expect("fixture");
        let retry_input = input::<PullRequestsReview>(retry_request);
        let retry_started = Instant::now();
        let retry = store.pull_requests_review(&who, retry_input);
        let retry_elapsed_ms = retry_started.elapsed().as_millis();
        writeln!(
            std::io::stdout(),
            "RETRY:{}:{retry_elapsed_ms}",
            retry.map_or_else(|e| e.protocol_code().as_str(), |_| "OK"),
        )
        .expect("barrier");
    }
}
#[test]
fn fix_admission_all_pr_entries_timeout_without_releasing_predecessor() {
    let k = Kb::new("admission");
    let pr = k.propose(&k.principal(&[Permission::Propose]), "topic.md");
    let head = k.user_branch(
        &k.store.owner(),
        "user/admission",
        &[("other.md", b"other")],
    );
    for (role, req) in [
        ("list", json!({"kbId":k.kb})),
        ("get", json!({"kbId":k.kb,"number":pr.number})),
        (
            "create",
            serde_json::to_value(k.create_input("user/admission", &head, "admit-create-key"))
                .expect("fixture"),
        ),
        (
            "review",
            serde_json::to_value(k.review_input(&pr, "merge", "admit-merge-key1"))
                .expect("fixture"),
        ),
    ] {
        let mut child = PolicyChild::new(&k, role, req, None);
        let guard = k
            .store
            .lock_write(std::slice::from_ref(&k.kb))
            .expect("fixture");
        child.start();
        assert_eq!(
            child.wait("RESULT:", Duration::from_millis(6500)),
            "RESULT:DEADLINE_EXCEEDED",
            "{role}"
        );
        assert!(
            child.method_elapsed_ms() < 5500,
            "{role}: method admission budget"
        );
        assert!(
            k.store.try_lock_write(&[]).expect("fixture").is_none(),
            "timeout released predecessor"
        );
        drop(guard);
    }
    // The same total deadline also covers waiting on the second lock.
    let mut child = PolicyChild::new(&k, "list", json!({"kbId":k.kb}), None);
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(k.store.paths().kb_lock_file(&k.kb))
        .expect("fixture");
    file.lock().expect("fixture");
    child.start();
    assert_eq!(
        child.wait("RESULT:", Duration::from_millis(6500)),
        "RESULT:DEADLINE_EXCEEDED"
    );
    assert!(child.method_elapsed_ms() < 5500);
    // Admission can be briefly busy with another test's spawn registry;
    // the store lock must still be obtainable while this KB lock is held.
    #[cfg(unix)]
    assert!(fixture::os_locks_available(k.store.paths().root(), &[]));
    drop(k.store.lock_write(&[]).expect("released store lock"));
    assert!(
        k.store
            .try_lock_write(std::slice::from_ref(&k.kb))
            .expect("fixture")
            .is_none()
    );
    drop(file);
    assert_eq!(k.get(pr.number, None).pr.head_sha, pr.head_sha);
    assert_eq!(k.head(), k.main);
    assert_eq!(k.epoch(), 1);
}
fn divergent_fixture(tag: &str) -> (Kb, PullRequestsReviewInput) {
    let k = Kb::new(tag);
    let pr = k.propose(&k.principal(&[Permission::Propose]), "topic.md");
    k.edit(
        &k.store.owner(),
        &k.main,
        "planner-main-key",
        edit("create", "human.md", "human"),
    );
    let req = k.review_input(&k.get(pr.number, None).pr, "merge", "planner-merge-key");
    (k, req)
}
fn scratch_count(k: &Kb) -> usize {
    std::fs::read_dir(k.store.paths().uploads_dir())
        .expect("fixture")
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().starts_with("publish-"))
        .count()
}
#[test]
fn fix_killed_preintent_planner_preserves_live_scratch_then_cleans_on_reopen() {
    let (k, req) = divergent_fixture("scratch-crash");
    let wrapper = parked_git::ParkedGit::new(&k.git.root, "commit-tree");
    let mut child = PolicyChild::new(
        &k,
        "review",
        serde_json::to_value(&req).expect("fixture"),
        Some(&wrapper.path),
    );
    child.start();
    wrapper.wait("mark");
    assert_eq!(scratch_count(&k), 1);
    assert!(
        !k.store
            .intents(&k.kb)
            .expect("fixture")
            .iter()
            .any(|i| i.operation == "PR_MERGE")
    );
    let upload = k.store.paths().uploads_dir().join("ordinary-upload");
    std::fs::create_dir(&upload).expect("fixture");
    std::fs::write(upload.join("keep"), b"upload").expect("fixture");
    let other = Store::open(k.store.paths().root()).expect("fixture");
    assert!(other.try_lock_write(&[]).expect("fixture").is_none());
    child.child.kill().expect("fixture");
    child.child.wait().expect("fixture");
    #[cfg(unix)]
    {
        assert!(wrapper.alive());
        assert!(other.try_lock_write(&[]).expect("fixture").is_none());
        assert_eq!(scratch_count(&k), 1, "live descendant scratch removed");
        std::fs::write(wrapper.bin.join("release"), b"go").expect("fixture");
        wrapper.wait("exited");
    }
    drop(child);
    let recovered = Store::open(k.store.paths().root()).expect("fixture");
    // Pre-intent scratch has no pending row to trigger a gated read.
    // Enter the recovery fence explicitly if startup deferred admission.
    drop(recovered.lock_write(&[]).expect("scratch recovery fence"));
    assert_eq!(scratch_count(&k), 0);
    assert_eq!(
        std::fs::read(upload.join("keep")).expect("fixture"),
        b"upload"
    );
    let out = recovered
        .pull_requests_review(&recovered.owner(), req.clone())
        .expect("fixture");
    assert_eq!(
        recovered
            .pull_requests_review(&recovered.owner(), req)
            .expect("fixture"),
        out
    );
    assert_eq!(recovered.read_kb(&k.kb).expect("fixture").desired_epoch, 3);
    assert_eq!(k.head(), out.pr.merge_commit_sha.expect("fixture"));
    assert_eq!(
        recovered
            .intents(&k.kb)
            .expect("fixture")
            .iter()
            .filter(|i| i.operation == "PR_MERGE")
            .count(),
        1
    );
}
#[test]
fn fix_operation_deadline_uses_one_budget_and_drains_planner_before_retry() {
    let (k, req) = divergent_fixture("operation-timeout");
    let wrapper = parked_git::ParkedGit::new(&k.git.root, "commit-tree");
    let mut child = PolicyChild::new(
        &k,
        "review-reentry",
        serde_json::to_value(&req).expect("fixture"),
        Some(&wrapper.path),
    );
    child.start();
    wrapper.wait("mark");
    assert_eq!(
        child.wait("RESULT:", Duration::from_secs(33)),
        "RESULT:DEADLINE_EXCEEDED"
    );
    assert!(child.method_elapsed_ms() < 32_000);
    assert!(!wrapper.alive(), "deadline returned before Git drain");
    assert_eq!(scratch_count(&k), 0);
    assert_eq!(k.epoch(), 2);
    assert_eq!(k.head(), req.expected_target_sha);
    assert!(
        !k.store
            .intents(&k.kb)
            .expect("fixture")
            .iter()
            .any(|i| i.operation == "PR_MERGE")
    );
    std::fs::write(wrapper.bin.join("release"), b"go").expect("fixture");
    child.start();
    // Observe the method's own budget, excluding scheduling and reply delivery.
    // A 30s receive timeout races the method's permitted 30s execution window.
    let reply = child.wait("RETRY:", Duration::from_secs(33));
    let elapsed_ms: u128 = reply
        .strip_prefix("RETRY:OK:")
        .expect("retry must succeed")
        .parse()
        .expect("retry duration");
    assert!(elapsed_ms < 30_000, "retry exceeded the procedure budget");
    let out = k
        .store
        .pull_requests_review(&k.store.owner(), req.clone())
        .expect("fixture");
    assert_eq!(
        k.store
            .pull_requests_review(&k.store.owner(), req)
            .expect("fixture"),
        out
    );
    assert_eq!(k.epoch(), 3);
}
#[test]
fn fix_repair_gate_covers_pr_and_document_receipts_and_restored_active_replay() {
    let mut k = Kb::new("repair-replay");
    let writer = k.principal(&[Permission::Write]);
    let author = k.principal(&[Permission::Propose]);
    let reviewer = k.principal(&[Permission::Review]);
    let head = k.user_branch(&author, "user/repair", &[("topic.md", b"topic")]);
    let create = k.create_input("user/repair", &head, "repair-create-key");
    let created = k
        .store
        .pull_requests_create(&author, create.clone())
        .expect("fixture");
    let close = k.review_input(&created.pr, "close", "repair-close-key1");
    let closed = k
        .store
        .pull_requests_review(&author, close.clone())
        .expect("fixture");
    let proposed = k.propose(&author, "proposal.md");
    let merge = k.review_input(&proposed, "merge", "repair-merge-key1");
    let merged = k
        .store
        .pull_requests_review(&reviewer, merge.clone())
        .expect("fixture");
    k.main = k.head();
    let changes = input::<ChangesApply>(
        json!({"kbId":k.kb,"baseRevision":k.main,"mode":"edit", "title":"later",
        "changes":edit("create", "later.md", "later"), "sourceSessionIds":[],"idempotencyKey":"repair-change-key"}),
    );
    let applied = k
        .store
        .changes_apply(&writer, changes.clone())
        .expect("fixture");
    let doc = input::<DocumentsCreate>(json!({"kbId":k.kb,"baseRevision":applied.commit_sha,
        "path":"document.md","content":{"markdown":"doc"},"idempotencyKey":"repair-document-key"}));
    let document = k
        .store
        .documents_create(&writer, doc.clone())
        .expect("fixture");
    let update = input::<DocumentsUpdate>(json!({"kbId":k.kb,"baseRevision":document.commit_sha,
        "path":"document.md","content":{"markdown":"updated"},"idempotencyKey":"repair-doc-update"}));
    let updated = k
        .store
        .documents_update(&writer, update.clone())
        .expect("fixture");
    let delete = input::<DocumentsDelete>(json!({"kbId":k.kb,"baseRevision":updated.commit_sha,
        "path":"document.md","idempotencyKey":"repair-doc-delete","confirm":"DELETE"}));
    let deleted = k
        .store
        .documents_delete(&writer, delete.clone())
        .expect("fixture");
    let epoch = k.epoch();
    for compact in [false, true] {
        let guard = k
            .store
            .lock_write(std::slice::from_ref(&k.kb))
            .expect("fixture");
        if compact {
            k.store.compact_receipts(&guard).expect("fixture");
        }
        let db = rusqlite::Connection::open(k.store.paths().state_db()).expect("fixture");
        db.execute(
            "UPDATE kbs SET state='REPAIR_REQUIRED' WHERE id=?1",
            [k.kb.as_str()],
        )
        .expect("fixture");
        drop(guard);
        code(
            k.store.pull_requests_create(&author, create.clone()),
            ErrorCode::RepairRequired,
        );
        code(
            k.store.pull_requests_review(&author, close.clone()),
            ErrorCode::RepairRequired,
        );
        code(
            k.store.pull_requests_review(&reviewer, merge.clone()),
            ErrorCode::RepairRequired,
        );
        code(
            k.store.changes_apply(&writer, changes.clone()),
            ErrorCode::RepairRequired,
        );
        code(
            k.store.documents_create(&writer, doc.clone()),
            ErrorCode::RepairRequired,
        );
        code(
            k.store.documents_update(&writer, update.clone()),
            ErrorCode::RepairRequired,
        );
        code(
            k.store.documents_delete(&writer, delete.clone()),
            ErrorCode::RepairRequired,
        );
        let metadata_input = input::<BasesUpdate>(json!({
            "kbId":k.kb,"metadataVersion":if compact {2} else {1},
            "name":"repair management", "idempotencyKey":if compact {"repair-meta-key2"} else {"repair-meta-key1"}
        }));
        code(
            k.store
                .bases_update(&k.store.owner(), metadata_input.clone()),
            ErrorCode::RepairRequired,
        );
        assert_eq!(
            k.store
                .kb(&k.kb)
                .expect("fixture")
                .expect("fixture")
                .metadata_version,
            if compact { 2 } else { 1 }
        );
        assert_eq!(
            k.store.kb(&k.kb).expect("fixture").expect("fixture").state,
            kb_local::KbState::RepairRequired
        );
        let guard = k
            .store
            .lock_write(std::slice::from_ref(&k.kb))
            .expect("fixture");
        db.execute("UPDATE kbs SET state='ACTIVE' WHERE id=?1", [k.kb.as_str()])
            .expect("fixture");
        drop(guard);
        let metadata = k
            .store
            .bases_update(&k.store.owner(), metadata_input.clone())
            .expect("metadata update after repair");
        assert_eq!(metadata.kb.name, "repair management");
        assert_eq!(
            k.store
                .bases_update(&k.store.owner(), metadata_input)
                .expect("metadata replay"),
            metadata
        );
        assert_eq!(
            k.store
                .pull_requests_create(&author, create.clone())
                .expect("fixture"),
            created
        );
        assert_eq!(
            k.store
                .pull_requests_review(&author, close.clone())
                .expect("fixture"),
            closed
        );
        assert_eq!(
            k.store
                .pull_requests_review(&reviewer, merge.clone())
                .expect("fixture"),
            merged
        );
        assert_eq!(
            k.store
                .changes_apply(&writer, changes.clone())
                .expect("fixture"),
            applied
        );
        assert_eq!(
            k.store
                .documents_create(&writer, doc.clone())
                .expect("fixture"),
            document
        );
        assert_eq!(
            k.store
                .documents_update(&writer, update.clone())
                .expect("fixture"),
            updated
        );
        assert_eq!(
            k.store
                .documents_delete(&writer, delete.clone())
                .expect("fixture"),
            deleted
        );
        assert_eq!(k.epoch(), epoch);
    }
    k.permissions(&writer, &[Permission::Read]);
    code(
        k.store.changes_apply(&writer, changes),
        ErrorCode::Forbidden,
    );
    code(k.store.documents_create(&writer, doc), ErrorCode::Forbidden);
    code(
        k.store.documents_update(&writer, update),
        ErrorCode::Forbidden,
    );
    code(
        k.store.documents_delete(&writer, delete),
        ErrorCode::Forbidden,
    );
    k.permissions(&author, &[Permission::Read]);
    code(
        k.store.pull_requests_create(&author, create),
        ErrorCode::Forbidden,
    );
    code(
        k.store.pull_requests_review(&author, close),
        ErrorCode::Forbidden,
    );
    k.permissions(&reviewer, &[Permission::Read]);
    code(
        k.store.pull_requests_review(&reviewer, merge),
        ErrorCode::Forbidden,
    );
}

#[test]
fn fix_scratch_recovery_preserves_foreign_names_and_refuses_links() {
    let k = Kb::new("scratch-names");
    let uploads = k.store.paths().uploads_dir();
    let name = "publish-11111111-1111-4111-8111-111111111111";
    let owned = uploads.join(name);
    std::fs::create_dir(&owned).expect("fixture");
    std::fs::write(owned.join("f1"), b"scratch").expect("fixture");
    let ordinary = uploads.join("publish-not-a-uuid");
    std::fs::create_dir(&ordinary).expect("fixture");
    let recovered = Store::open(k.store.paths().root()).expect("fixture");
    drop(recovered.lock_write(&[]).expect("scratch recovery fence"));
    assert!(!owned.exists());
    assert!(ordinary.is_dir());
    #[cfg(unix)]
    {
        let sentinel = k.git.root.join("foreign");
        std::fs::create_dir(&sentinel).expect("fixture");
        std::fs::write(sentinel.join("keep"), b"foreign").expect("fixture");
        std::os::unix::fs::symlink(&sentinel, &owned).expect("fixture");
        code(recovered.lock_write(&[]), ErrorCode::RepairRequired);
        assert_eq!(
            std::fs::read(sentinel.join("keep")).expect("fixture"),
            b"foreign"
        );
        std::fs::remove_file(owned).expect("fixture");
        assert!(fixture::os_locks_available(recovered.paths().root(), &[]));
        drop(
            recovered
                .lock_write(&[])
                .expect("re-entry after link removal"),
        );
    }
}

#[test]
fn fix_timeout_after_reservation_recovers_abort_before_new_key_publication() {
    let (k, mut req) = divergent_fixture("reserved-timeout");
    let old = k.head();
    let wrapper = parked_git::ParkedGit::new(&k.git.root, "update-ref");
    let mut child = PolicyChild::new(
        &k,
        "review",
        serde_json::to_value(&req).expect("fixture"),
        Some(&wrapper.path),
    );
    child.start();
    wrapper.wait("mark");
    let intents = k.store.intents(&k.kb).expect("fixture");
    assert_eq!(
        intents
            .iter()
            .find(|i| i.operation == "PR_MERGE")
            .expect("fixture")
            .phase,
        Phase::Committing
    );
    assert_eq!(
        child.wait("RESULT:", Duration::from_secs(33)),
        "RESULT:DEADLINE_EXCEEDED"
    );
    assert!(!wrapper.alive());
    let recovered = Store::open(k.store.paths().root()).expect("fixture");
    assert_eq!(k.head(), old);
    assert_eq!(recovered.read_kb(&k.kb).expect("fixture").desired_epoch, 2);
    code(
        recovered.pull_requests_review(&recovered.owner(), req.clone()),
        ErrorCode::Conflict,
    );
    assert_eq!(
        recovered
            .intents(&k.kb)
            .expect("fixture")
            .iter()
            .find(|i| i.operation == "PR_MERGE")
            .expect("fixture")
            .phase,
        Phase::Aborted
    );
    req.idempotency_key = IdempotencyKey::parse("reserved-new-key").expect("fixture");
    let out = recovered
        .pull_requests_review(&recovered.owner(), req.clone())
        .expect("fixture");
    assert_eq!(
        recovered
            .pull_requests_review(&recovered.owner(), req)
            .expect("fixture"),
        out
    );
    assert_eq!(recovered.read_kb(&k.kb).expect("fixture").desired_epoch, 3);
}

#[test]
fn r52c_pr_mutations_share_durable_budget_and_exempt_replay() {
    // The local per-actor, per-KB write window.
    const FULL: usize = kb_local::limits::LOCAL_MUTATIONS_PER_MINUTE_PER_KB;
    let k = Kb::new("r52c-pr-budget");
    k.store.set_cursor_clock_for_tests(2_000_000_000);
    let owner = k.store.owner();
    let head = k.user_branch(&owner, "user/budget", &[("budget.md", b"# Budget\n")]);
    let db = rusqlite::Connection::open(k.store.paths().state_db()).expect("db");
    let seed = |count| {
        db.execute("INSERT INTO mutation_windows(actor_key,kb_id,times_json) VALUES (?1,?2,?3) ON CONFLICT(actor_key,kb_id) DO UPDATE SET times_json=excluded.times_json",
            (owner.actor_key(), k.kb.as_str(),serde_json::to_string(&vec![2_000_000_000_000u64;count]).expect("encode"))).expect("seed durable window");
    };
    let charges = || {
        db.query_row("SELECT json_array_length(times_json) FROM mutation_windows WHERE actor_key=?1 AND kb_id=?2",
        (owner.actor_key(),k.kb.as_str()),|r|r.get::<_,i64>(0)).expect("charges")
    };
    seed(FULL - 1);
    let request = k.create_input("user/budget", &head, "r52c-pr-create-0000");
    let created = k
        .store
        .pull_requests_create(&owner, request.clone())
        .expect("last mutation in the window");
    assert_eq!(charges(), FULL as i64);
    assert_eq!(
        k.store
            .pull_requests_create(&owner, request)
            .expect("PR replay at full window")
            .operation_id,
        created.operation_id
    );
    for decision in ["close", "merge"] {
        code(
            k.review(
                &owner,
                &created.pr,
                decision,
                &format!("r52c-pr-{decision}-0000"),
            ),
            ErrorCode::RateLimited,
        );
        assert_eq!(k.head(), k.main);
        assert_eq!(k.get(created.pr.number, None).pr.status, PrStatus::Open);
    }
    seed(FULL - 1);
    let merged = k
        .review(&owner, &created.pr, "merge", "r52c-pr-merge-0000")
        .expect("merge last slot");
    assert_eq!(charges(), FULL as i64);
    assert_eq!(
        k.review(&owner, &created.pr, "merge", "r52c-pr-merge-0000")
            .expect("merge replay")
            .operation_id,
        merged.operation_id
    );
    assert_eq!(charges(), FULL as i64);
    // Closing a different PR also charges with its finalized receipt.
    k.store.advance_clock_for_tests(60);
    let proposer = k.principal(&[Permission::Propose]);
    let main = k.head();
    let proposal = k
        .edit(
            &proposer,
            &main,
            "r52c-pr-propose-0000",
            edit("create", "close.md", "# Close\n"),
        )
        .proposal
        .expect("proposal");
    let closed = k
        .review(&owner, &proposal, "close", "r52c-pr-close-final-0000")
        .expect("close fresh window");
    assert_eq!(charges(), 1);
    assert_eq!(
        k.review(&owner, &proposal, "close", "r52c-pr-close-final-0000")
            .expect("close replay")
            .operation_id,
        closed.operation_id
    );
    assert_eq!(charges(), 1);
}

/// The wire form of a PROPOSAL_CONFLICT is a valid kb/1 envelope.
fn proposal_conflict(error: StoreError) -> Box<kb_client::error::ProposalConflict> {
    assert_eq!(error.protocol_code(), ErrorCode::Conflict);
    kb_client::error::ToolError::from_value(&json!({
        "code": "CONFLICT", "message": ErrorCode::Conflict.message(), "retryable": false,
        "details": error.protocol_details(),
    }))
    .expect("kb/1 envelope");
    match error {
        StoreError::ProposalConflict(conflict) => conflict,
        other => panic!("expected PROPOSAL_CONFLICT, got {other:?}"),
    }
}

/// R3-L3: locally, as on the server: a clashing PR reads CONFLICT and
/// refuses to merge with typed details; the author moves it onto main by
/// proposing against current main, progressively, keeping its number and
/// title; then it merges.
#[test]
fn conflicting_proposal_is_marked_resolved_progressively_moved_onto_main_and_merged() {
    let k = Kb::new("d11-local");
    let author = k.principal(&[Permission::Propose]);
    let owner = k.store.owner();
    let first = k.edit(
        &author,
        &k.main,
        "d11-propose-0001-key",
        json!([
            {"op":"create","path":"proposals/three.md","content":{"markdown":"# Three\n\nfrom the PR\n"}},
            {"op":"create","path":"proposals/four.md","content":{"markdown":"# Four\n\nfrom the PR\n"}},
            {"op":"create","path":"proposals/free.md","content":{"markdown":"# Free\n"}}
        ]),
    );
    let pr = first.proposal.clone().expect("proposal");
    assert_eq!(pr.status, PrStatus::Open);
    let title = pr.title.clone();
    // Main creates the same paths.
    let main = k
        .edit(
            &owner,
            &k.main,
            "d11-main-000001-key",
            json!([
                {"op":"create","path":"proposals/three.md","content":{"markdown":"# Three\n\nfrom main\n"}},
                {"op":"create","path":"proposals/four.md","content":{"markdown":"# Four\n\nfrom main\n"}}
            ]),
        )
        .commit_sha;
    let viewed = k.get(pr.number, None).pr;
    assert_eq!(
        (viewed.status, &viewed.target_sha),
        (PrStatus::Conflict, &main)
    );
    let listed = k.list();
    assert_eq!(
        (listed[0].status, &listed[0].target_sha),
        (PrStatus::Conflict, &main)
    );
    // Merge refuses with every clashing path and its three versions.
    let refused = proposal_conflict(
        k.review(&owner, &viewed, "merge", "d11-merge-00001-key")
            .expect_err("conflicting merge"),
    );
    assert_eq!(refused.head_sha, main);
    let paths: Vec<_> = refused.paths.iter().map(|p| p.path.as_str()).collect();
    assert_eq!(paths, ["proposals/four.md", "proposals/three.md"]);
    let three = &refused.paths[1];
    assert_eq!(three.base, None);
    assert_eq!(three.theirs.as_deref(), Some("# Three\n\nfrom main\n"));
    assert_eq!(three.yours.as_deref(), Some("# Three\n\nfrom the PR\n"));
    assert_eq!(
        (three.theirs_sha.clone(), three.yours_sha.clone()),
        (main.clone(), pr.head_sha.clone())
    );
    assert_eq!(k.head(), main);
    // Against the PR head the update is accepted but keeps the clash.
    let stale = k.try_edit(
        &author,
        &main,
        "d11-stale-00001-key",
        edit("create", "other.md", "o"),
        Some(99),
    );
    assert_eq!(
        stale.expect_err("unknown PR").protocol_code(),
        ErrorCode::NotFound
    );
    // Against main, a request that resolves nothing changes nothing.
    let refused = proposal_conflict(
        k.try_edit(
            &author,
            &main,
            "d11-unrelated-01-key",
            edit("create", "other.md", "o"),
            None,
        )
        .expect_err("no progress"),
    );
    assert_eq!(refused.proposal_number, Some(pr.number as i64));
    assert_eq!(refused.paths.len(), 2);
    assert_eq!(k.get(pr.number, None).pr.head_sha, pr.head_sha);
    // Resolving one conflict moves the PR onto main; the other stays recorded.
    let step = k
        .try_edit_pr(
            &author,
            &main,
            "d11-resolve-0001-key",
            edit("replace", "proposals/three.md", "# Three\n\nresolved\n"),
            pr.number,
            &pr.head_sha,
        )
        .expect("progress");
    // Progressive resolution chains heads: a second editor still holding the
    // pre-move head cannot resolve (or overwrite) the moved PR.
    match k
        .try_edit_pr(
            &author,
            &main,
            "d11-resolve-stale-key",
            edit("replace", "proposals/four.md", "# Four\n\nstale\n"),
            pr.number,
            &pr.head_sha,
        )
        .expect_err("stale head")
    {
        StoreError::StaleBase { head_sha, .. } => assert_eq!(head_sha, step.commit_sha),
        other => panic!("expected StaleBase, got {other:?}"),
    }
    let moved = step.proposal.clone().expect("proposal");
    assert_eq!(moved.number, pr.number);
    assert_eq!(moved.title, title, "R3-W5: the title is kept");
    assert_eq!(moved.base_sha, main, "the PR moved onto main");
    assert_eq!(moved.status, PrStatus::Conflict);
    assert_eq!(
        k.git
            .git(&["show", "-s", "--format=%P", step.commit_sha.as_str()]),
        format!("{} {}", main, pr.head_sha),
        "the previous head stays reachable as a second parent"
    );
    let recorded = proposal_conflict(
        k.review(
            &owner,
            &k.get(pr.number, None).pr,
            "merge",
            "d11-merge-00002-key",
        )
        .expect_err("still conflicting"),
    );
    let paths: Vec<_> = recorded.paths.iter().map(|p| p.path.as_str()).collect();
    assert_eq!(paths, ["proposals/four.md"]);
    assert_eq!(
        recorded.paths[0].yours_sha, pr.head_sha,
        "recorded versions stay readable"
    );
    // Writing the last one (keep mine, even identical bytes) resolves it.
    let done = k
        .try_edit(
            &author,
            &main,
            "d11-resolve-0002-key",
            edit("replace", "proposals/four.md", "# Four\n\nfrom the PR\n"),
            None,
        )
        .expect_err("a recorded conflict is resolved only by naming the PR");
    assert_eq!(done.protocol_details()["reason"], "PROPOSAL_CONFLICT");
    // The same write, naming the PR with the head it read, resolves it
    // (keep mine, identical bytes).
    let done = k
        .try_edit_pr(
            &author,
            &main,
            "d11-resolve-0003-key",
            edit("replace", "proposals/four.md", "# Four\n\nfrom the PR\n"),
            pr.number,
            &step.commit_sha,
        )
        .expect("resolution");
    let open = done.proposal.clone().expect("proposal");
    assert_eq!(
        (open.status, open.version),
        (PrStatus::Open, pr.version + 2)
    );
    assert_eq!(open.title, title);
    let viewed = k.get(pr.number, None).pr;
    assert_eq!(viewed.status, PrStatus::Open);
    let merged = k
        .review(&owner, &viewed, "merge", "d11-merge-00003-key")
        .expect("merges once resolved");
    assert_eq!(merged.pr.status, PrStatus::Merged);
    let head = k.head();
    for (path, body) in [
        ("proposals/three.md", "# Three\n\nresolved\n"),
        ("proposals/four.md", "# Four\n\nfrom the PR\n"),
        ("proposals/free.md", "# Free\n"),
    ] {
        assert_eq!(
            k.git.git(&["show", &format!("{head}:{path}")]),
            body.trim_end()
        );
    }
}

/// A move onto main replays the PR's clean changes, and a line merge both
/// sides can combine is not a conflict.
#[test]
fn moving_onto_main_replays_clean_changes_and_line_merges() {
    let k = Kb::new("d11-replay");
    let author = k.principal(&[Permission::Propose]);
    let owner = k.store.owner();
    let base = k
        .edit(
            &owner,
            &k.main,
            "replay-base-0001-key",
            edit("create", "shared.md", "one\ntwo\nthree\nfour\nfive\n"),
        )
        .commit_sha;
    let pr = k
        .try_edit(
            &author,
            &base,
            "replay-pr-00001-key",
            edit("replace", "shared.md", "ONE\ntwo\nthree\nfour\nfive\n"),
            None,
        )
        .expect("proposal")
        .proposal
        .expect("proposal");
    let main = k
        .edit(
            &owner,
            &base,
            "replay-main-001-key",
            edit("replace", "shared.md", "one\ntwo\nthree\nfour\nFIVE\n"),
        )
        .commit_sha;
    // Lines combine: the PR still merges.
    let viewed = k.get(pr.number, None).pr;
    assert_eq!(viewed.status, PrStatus::Open);
    // An update against main moves it onto main with both edits.
    let moved = k
        .try_edit(
            &author,
            &main,
            "replay-move-001-key",
            edit("create", "new.md", "new"),
            None,
        )
        .expect("move onto main");
    assert_eq!(moved.proposal.as_ref().map(|p| &p.base_sha), Some(&main));
    assert_eq!(
        k.git
            .git(&["show", &format!("{}:shared.md", moved.commit_sha)]),
        "ONE\ntwo\nthree\nfour\nFIVE"
    );
    // Rewriting the PR's own path against main without naming it clashes.
    let refused = proposal_conflict(
        k.try_edit(
            &author,
            &main,
            "replay-over-001-key",
            edit("replace", "shared.md", "x"),
            None,
        )
        .expect_err("overwrite guard"),
    );
    assert_eq!(refused.paths[0].path, "shared.md");
}

/// Write many blobs in one Git process (`hash-object --stdin-paths`).
fn bulk_blobs(k: &Kb, contents: &[Vec<u8>]) -> Vec<String> {
    let dir = k.git.root.join(format!("bulk-{}", contents.len()));
    std::fs::create_dir_all(&dir).expect("fixture");
    let mut list = String::new();
    for (i, bytes) in contents.iter().enumerate() {
        let path = dir.join(format!("b{i}"));
        std::fs::write(&path, bytes).expect("fixture");
        list.push_str(path.to_str().expect("utf8"));
        list.push('\n');
    }
    let mut child = ChildGuard::new(
        Command::new("git")
            .arg("--git-dir")
            .arg(&k.git.repo)
            .args(["hash-object", "-w", "--no-filters", "--stdin-paths"])
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("git"),
    );
    // Feed stdin from a thread: Git answers line by line and would block on
    // a full stdout pipe while we are still writing.
    let mut stdin = child.stdin.take().expect("stdin");
    let feeder = std::thread::spawn(move || stdin.write_all(list.as_bytes()).expect("fixture"));
    let out = child.wait_with_output().expect("git");
    feeder.join().expect("feeder");
    assert!(out.status.success());
    std::fs::remove_dir_all(&dir).expect("fixture");
    String::from_utf8(out.stdout)
        .expect("utf8")
        .lines()
        .map(str::to_owned)
        .collect()
}

/// A commit of the required files plus `dir/<name>` documents (one flat dir).
fn bulk_commit(k: &Kb, dir: &str, docs: &[(String, Vec<u8>)], parents: &[&str]) -> Sha {
    let shas = bulk_blobs(k, &docs.iter().map(|(_, b)| b.clone()).collect::<Vec<_>>());
    let mut entries: Vec<(&str, &[u8], &str)> = docs
        .iter()
        .zip(&shas)
        .map(|((name, _), sha)| ("100644", name.as_bytes(), sha.as_str()))
        .collect();
    entries.sort_by(|a, b| a.1.cmp(b.1));
    let sub = k.git.raw_tree(&entries);
    let required = with_required(&[]);
    let mut root: Vec<(String, Vec<u8>, String)> = required
        .iter()
        .map(|(path, bytes)| (path.to_string(), bytes.to_vec(), String::new()))
        .collect();
    // Required files may sit in a subdirectory: build them with the helper.
    let base_tree = k.git.tree(&required);
    let listing = k.git.git(&["ls-tree", &base_tree]);
    root.clear();
    let mut top: Vec<(String, String, String)> = listing
        .lines()
        .map(|line| {
            let (meta, name) = line.split_once('\t').expect("ls-tree");
            let parts: Vec<&str> = meta.split(' ').collect();
            (parts[0].to_owned(), name.to_owned(), parts[2].to_owned())
        })
        .collect();
    top.push(("40000".into(), dir.into(), sub));
    // Git orders a directory as if its name ended in `/`.
    top.sort_by(|a, b| {
        let key = |e: &(String, String, String)| {
            let mut k = e.1.clone().into_bytes();
            if e.0 == "40000" {
                k.push(b'/');
            }
            k
        };
        key(a).cmp(&key(b))
    });
    let entries: Vec<(&str, &[u8], &str)> = top
        .iter()
        .map(|(mode, name, sha)| (mode.as_str(), name.as_bytes(), sha.as_str()))
        .collect();
    let tree = k.git.raw_tree(&entries);
    sha(&k.git.commit(&tree, parents))
}

/// The shared real-Git corpus (`fixtures/text-merge-cases.json`, generated by
/// the server's merge): every case is one document of ONE local merge, and
/// the clean results and clashes match the server exactly (R3 review: native
/// merge parity, not stubbed line merges).
#[test]
fn native_line_merges_match_the_servers_real_git_corpus() {
    let corpus: Value = serde_json::from_str(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../packages/api/src/lib/kb/fixtures/text-merge-cases.json"
        ))
        .expect("corpus"),
    )
    .expect("corpus json");
    let cases = corpus["cases"].as_array().expect("cases");
    assert!(cases.len() >= 30);
    let k = Kb::new("text-merge");
    let side = |key: &str| -> Vec<(String, Vec<u8>)> {
        cases
            .iter()
            .enumerate()
            .filter_map(|(i, c)| {
                c[key]
                    .as_str()
                    .map(|t| (format!("c{i:02}.md"), t.as_bytes().to_vec()))
            })
            .collect()
    };
    let base = bulk_commit(&k, "cases", &side("base"), &[]);
    let main = bulk_commit(&k, "cases", &side("main"), &[base.as_str()]);
    let head = bulk_commit(&k, "cases", &side("proposal"), &[base.as_str()]);
    let (conflicts, documents) = k
        .store
        .logical_merge_for_tests(&k.kb, &main, &head)
        .expect("merge");
    for (i, c) in cases.iter().enumerate() {
        let path = format!("cases/c{i:02}.md");
        let got = if conflicts.contains(&path) {
            None
        } else {
            Some(String::from_utf8(documents[&path].clone()).expect("utf8"))
        };
        assert_eq!(got.as_deref(), c["merged"].as_str(), "{}", c["name"]);
    }
}

/// Near the repository limits (4,000 documents, each changed cleanly on both
/// sides), the status check and the reviewed merge stay inside the 30-second
/// PR deadline: one merge-tree for every line merge, not one Git process per
/// document (R3 review). The deadline itself is not raised.
#[test]
fn four_thousand_line_merges_fit_the_pr_deadline() {
    let k = Kb::new("near-limit-merges");
    let owner = k.store.owner();
    let author = k.principal(&[Permission::Propose]);
    const N: usize = 4000;
    let docs = |f: &dyn Fn(usize) -> String| -> Vec<(String, Vec<u8>)> {
        (0..N)
            .map(|i| (format!("d{i:04}.md"), f(i).into_bytes()))
            .collect()
    };
    let base_docs = docs(&|i| format!("# Doc {i}\n\none\ntwo\nthree\nfour\nfive\n"));
    let main_docs = docs(&|i| format!("# Doc {i}\n\nONE\ntwo\nthree\nfour\nfive\n"));
    let pr_docs = docs(&|i| format!("# Doc {i}\n\none\ntwo\nthree\nfour\nFIVE\n"));
    // Build the input graph outside PR deadlines. Fast-forward publication has
    // its own tests; this test measures the divergent status/read/merge work.
    let base = bulk_commit(&k, "bulk", &base_docs, &[k.main.as_str()]);
    let main = bulk_commit(&k, "bulk", &main_docs, &[base.as_str()]);
    k.git.set_ref("refs/heads/main", main.as_str());
    rusqlite::Connection::open(k.store.paths().state_db())
        .expect("fixture")
        .execute(
            "UPDATE kbs SET head_sha=?2 WHERE id=?1",
            (k.kb.as_str(), main.as_str()),
        )
        .expect("fixture head");
    let head = bulk_commit(&k, "bulk", &pr_docs, &[base.as_str()]);
    let name = "refs/heads/author/bulk";
    k.git.set_ref(name, head.as_str());
    {
        let guard = k
            .store
            .lock_write(std::slice::from_ref(&k.kb))
            .expect("fixture");
        rusqlite::Connection::open(k.store.paths().state_db())
            .expect("fixture")
            .execute(
                "INSERT INTO branch_owners VALUES (?1, ?2, ?3, 'USER', 'fixture')",
                (k.kb.as_str(), name, author.actor_key()),
            )
            .expect("fixture");
        drop(guard);
    }
    // One pack is a durable seed; timed calls do not inherit dirty fixture
    // inodes or run unrelated fast-forward journals against their PR budget.
    k.git.git(&[
        "-c",
        "core.fsync=pack,pack-metadata",
        "-c",
        "core.fsyncMethod=fsync",
        "repack",
        "-a",
    ]);
    let pack_dir = k.git.repo.join("objects/pack");
    for dir in [&pack_dir, &k.git.repo.join("objects"), &k.git.repo] {
        kb_local::paths::sync_dir(dir).expect("durable fixture entries");
    }
    let started = Instant::now();
    let pr = k
        .store
        .pull_requests_create(
            &author,
            input::<PullRequestsCreate>(json!({
                "kbId":k.kb,"headBranch":"author/bulk","expectedHeadSha":head,
                "expectedTargetSha":main,"title":"Bulk edits","idempotencyKey":"bulk-author-create"
            })),
        )
        .expect("create (status checked)")
        .pr;
    assert_eq!(pr.status, PrStatus::Open);
    let viewed = k.get(pr.number, None).pr;
    assert_eq!(viewed.status, PrStatus::Open);
    let merged = k
        .review(&owner, &viewed, "merge", "bulk-author-merge")
        .expect("merge within the deadline");
    assert_eq!(merged.pr.status, PrStatus::Merged);
    assert_eq!(
        k.git.git(&["show", &format!("{}:bulk/d3999.md", k.head())]),
        "# Doc 3999\n\nONE\ntwo\nthree\nfour\nFIVE"
    );
    // Create, the read and the merge each stay far inside their 30 s budget.
    assert!(
        started.elapsed() < Duration::from_secs(60),
        "{:?}",
        started.elapsed()
    );
}

/// Two documents both sides changed on the same line: a real conflict.
fn clashing_pr(tag: &str) -> (Kb, PrSummary, Sha) {
    let (k, pr, main, _) = clashing_pr_by(tag);
    (k, pr, main)
}

/// [`clashing_pr`] with its author.
fn clashing_pr_by(tag: &str) -> (Kb, PrSummary, Sha, LocalPrincipal) {
    let k = Kb::new(tag);
    let author = k.principal(&[Permission::Propose]);
    let owner = k.store.owner();
    let seeded = k
        .edit(
            &owner,
            &k.main,
            &format!("{tag}-seed-key"),
            edit("create", "shared.md", "one\n"),
        )
        .commit_sha;
    let pr = k
        .try_edit(
            &author,
            &seeded,
            &format!("{tag}-pr-key-01"),
            edit("replace", "shared.md", "pr\n"),
            None,
        )
        .expect("proposal")
        .proposal
        .expect("proposal");
    let main = k
        .edit(
            &owner,
            &seeded,
            &format!("{tag}-main-key-1"),
            edit("replace", "shared.md", "main\n"),
        )
        .commit_sha;
    (k, pr, main, author)
}

/// R3 review: the status filter of a list sees statuses made current first
/// (no prior read), so a freshly clashing PR is found under CONFLICT and not
/// under OPEN, with the main it was checked against.
#[test]
fn list_filters_on_current_statuses() {
    let (k, pr, main) = clashing_pr("list-current");
    let by = |status: &str| {
        k.store
            .pull_requests_list(
                &k.store.owner(),
                input::<PullRequestsList>(json!({"kbId":k.kb,"status":status})),
            )
            .expect("list")
            .items
    };
    assert!(by("OPEN").is_empty());
    let conflicted = by("CONFLICT");
    assert_eq!(conflicted.len(), 1);
    assert_eq!(
        (conflicted[0].number, &conflicted[0].target_sha),
        (pr.number, &main)
    );
}

/// R3 review: a Git execution failure during the status check is an error,
/// never a cached or recorded content conflict.
#[test]
fn git_failures_never_become_conflicts() {
    let (k, pr, _) = clashing_pr("git-failure");
    let wrapper = parked_git::ParkedGit::new(&k.git.root, "fail-merge-tree");
    let mut child = PolicyChild::new(
        &k,
        "get",
        json!({"kbId":k.kb,"number":pr.number}),
        Some(&wrapper.path),
    );
    child.start();
    assert_eq!(
        child.wait("RESULT:", Duration::from_secs(30)),
        "RESULT:STORAGE_UNAVAILABLE"
    );
    drop(child);
    let db = rusqlite::Connection::open(k.store.paths().state_db()).expect("fixture");
    let (status, checked): (String, Option<String>) = db
        .query_row(
            "SELECT status, merge_checked_sha FROM pull_requests WHERE kb_id=?1 AND number=?2",
            (k.kb.as_str(), pr.number as i64),
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("row");
    assert_eq!(status, "OPEN", "no conflict was cached");
    assert_eq!(
        checked.as_deref(),
        Some(pr.base_sha.as_str()),
        "the old check stands"
    );
    // With a working Git the same read reports the real clash.
    assert_eq!(k.get(pr.number, None).pr.status, PrStatus::Conflict);
}

/// R3 review: retrying a refused merge with its key replays the typed
/// PROPOSAL_CONFLICT (paths and versions), not a bare CONFLICT.
#[test]
fn a_refused_merge_replays_its_typed_details() {
    let (k, pr, _) = clashing_pr("typed-replay");
    let viewed = k.get(pr.number, None).pr;
    let first = k
        .review(&k.store.owner(), &viewed, "merge", "typed-replay-merge-1")
        .expect_err("refused");
    let again = k
        .review(&k.store.owner(), &viewed, "merge", "typed-replay-merge-1")
        .expect_err("replayed");
    assert_eq!(first.protocol_details()["reason"], "PROPOSAL_CONFLICT");
    assert_eq!(again.protocol_details(), first.protocol_details());
    // A reader without the PR's KB still gets nothing back.
    let stranger = k.principal(&[]);
    assert_ne!(
        k.review(&stranger, &viewed, "merge", "typed-replay-merge-1")
            .expect_err("forbidden")
            .protocol_code(),
        ErrorCode::Conflict
    );
}

/// R3 review: a dream PR is pinned to its own main — neither an ordinary
/// edit naming it nor the author's implicit selection moves it onto main.
#[test]
fn ordinary_edits_never_move_a_dream_pr() {
    let k = Kb::new("dream-pinned");
    let author = k.principal(&[Permission::Propose]);
    let dreamt = k.dream(&author, "dream-pinned-key-01", "dreamt body\n");
    let pr = dreamt.proposal.expect("dream proposal");
    let main = k
        .edit(
            &k.store.owner(),
            &k.main,
            "dream-pinned-main1",
            edit("create", "human.md", "h"),
        )
        .commit_sha;
    // Named (with the head the caller read) and implicit selection alike.
    let named = k.try_edit_pr(
        &author,
        &main,
        "dream-pinned-named1",
        edit("create", "other.md", "o"),
        pr.number,
        &pr.head_sha,
    );
    let implicit = k.try_edit(
        &author,
        &main,
        "dream-pinned-implic",
        edit("create", "other.md", "o"),
        None,
    );
    for (key, result) in [("named", named), ("implicit", implicit)] {
        match result.expect_err("pinned") {
            StoreError::StaleBase { head_sha, .. } => assert_eq!(head_sha, pr.head_sha, "{key}"),
            other => panic!("{key}: expected StaleBase, got {other:?}"),
        }
    }
    assert_eq!(k.get(pr.number, None).pr.base_sha, pr.base_sha);
}

/// R3 review: a no-op names the revision it was evaluated on — the PR head a
/// request against main reached, never the request's base.
#[test]
fn a_noop_reached_from_main_names_the_pr_head() {
    let k = Kb::new("noop-head");
    let author = k.principal(&[Permission::Propose]);
    let owner = k.store.owner();
    let seeded = k
        .edit(
            &owner,
            &k.main,
            "noop-head-seed-01",
            edit("create", "b.md", "bee\n"),
        )
        .commit_sha;
    let pr = k
        .try_edit(
            &author,
            &seeded,
            "noop-head-pr-0001",
            edit("create", "a.md", "a"),
            None,
        )
        .expect("proposal")
        .proposal
        .expect("proposal");
    let noop = k
        .try_edit(
            &author,
            &seeded,
            "noop-head-same-01",
            edit("replace", "b.md", "bee\n"),
            None,
        )
        .expect("noop");
    assert_eq!(noop.kind, ApplyKind::Noop);
    assert_eq!(noop.commit_sha, pr.head_sha);
    assert_eq!(noop.proposal.map(|p| p.head_sha), Some(pr.head_sha));
}

/// A fresh no-op is validated like a read/merge, even without publication.
#[test]
fn fresh_noop_checks_status_against_locked_main() {
    let (k, pr, main, author) = clashing_pr_by("noop-checked");
    let noop = k
        .try_edit_pr(
            &author,
            &pr.head_sha,
            "noop-checked-same1",
            edit("replace", "shared.md", "pr\n"),
            pr.number,
            &pr.head_sha,
        )
        .expect("noop");
    assert_eq!(noop.kind, ApplyKind::Noop);
    let summary = noop.proposal.expect("proposal");
    assert_eq!(summary.status, PrStatus::Conflict);
    assert_eq!(summary.target_sha, main);
    assert_eq!(summary, k.get(pr.number, None).pr);
}

/// Every object in the canonical repository (loose and packed).
fn object_set(k: &Kb) -> std::collections::BTreeSet<String> {
    k.git
        .git(&[
            "cat-file",
            "--batch-all-objects",
            "--batch-check=%(objectname)",
        ])
        .lines()
        .map(str::to_owned)
        .collect()
}

/// R3 review: planning never writes into the canonical object store —
/// status reads, refused merges and refused updates leave its object set
/// unchanged; only a successful publication promotes what it needs.
#[test]
fn status_reads_and_rejected_plans_leave_canonical_objects_unchanged() {
    let (k, pr, main) = clashing_pr("canonical-objects");
    let author = k
        .store
        .proposal(&k.kb, pr.number)
        .expect("fixture")
        .expect("pr")
        .author_actor_key;
    let _ = author;
    let before = object_set(&k);
    // A status read (the merge plan with line merges and a candidate tree).
    assert_eq!(k.get(pr.number, None).pr.status, PrStatus::Conflict);
    assert_eq!(k.list().len(), 1);
    assert_eq!(object_set(&k), before, "status reads");
    // A refused merge.
    let viewed = k.get(pr.number, None).pr;
    assert!(
        k.review(&k.store.owner(), &viewed, "merge", "canonical-merge-key")
            .is_err()
    );
    assert_eq!(object_set(&k), before, "refused merge");
    // A refused update (resolves nothing, PROPOSAL_CONFLICT) and a refused
    // edit (whole-tree validation: a duplicated document id).
    let proposer = k.principal(&[Permission::Propose]);
    let _ = k.try_edit(
        &proposer,
        &main,
        "canonical-refused-1",
        edit("create", "x.md", "x"),
        None,
    );
    let owner = k.store.owner();
    k.edit(
        &owner,
        &main,
        "canonical-id-seed01",
        edit("create", "id.md", "---\nid: same\n---\na"),
    );
    let seeded = object_set(&k);
    let head = k.head();
    assert!(
        k.try_edit(
            &owner,
            &head,
            "canonical-id-dupe1",
            edit("create", "dup.md", "---\nid: same\n---\nb"),
            None
        )
        .is_err()
    );
    assert_eq!(object_set(&k), seeded, "refused edits");
}

/// A commit of the required files plus `docs` (deep paths) built with one
/// index: `update-index --index-info` then `write-tree`.
fn deep_commit(k: &Kb, docs: &[(String, Vec<u8>)], parents: &[&str]) -> Sha {
    let mut files: Vec<(String, Vec<u8>)> = with_required(&[])
        .into_iter()
        .map(|(p, b)| (p.to_owned(), b.to_vec()))
        .collect();
    files.extend(docs.iter().cloned());
    let shas = bulk_blobs(k, &files.iter().map(|(_, b)| b.clone()).collect::<Vec<_>>());
    let index = k.git.root.join(format!("deep-index-{}", files.len()));
    let _ = std::fs::remove_file(&index);
    let mut info = String::new();
    for ((path, _), sha) in files.iter().zip(&shas) {
        info.push_str(&format!("100644 {sha}\t{path}\n"));
    }
    let run = |args: &[&str], input: Option<&str>| -> String {
        let mut child = ChildGuard::new(
            Command::new("git")
                .arg("--git-dir")
                .arg(&k.git.repo)
                .args(args)
                .env("GIT_INDEX_FILE", &index)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .expect("git"),
        );
        let mut stdin = child.stdin.take().expect("stdin");
        let text = input.unwrap_or("").to_owned();
        let feeder = std::thread::spawn(move || stdin.write_all(text.as_bytes()).expect("fixture"));
        let out = child.wait_with_output().expect("git");
        feeder.join().expect("feeder");
        assert!(out.status.success());
        String::from_utf8(out.stdout)
            .expect("utf8")
            .trim()
            .to_owned()
    };
    run(&["update-index", "--add", "--index-info"], Some(&info));
    let tree = run(&["write-tree"], None);
    std::fs::remove_file(&index).expect("fixture");
    sha(&k.git.commit(&tree, parents))
}

/// R3 review: a valid tree with thousands of distinct subtrees (320
/// documents, each 24 directories deep: 7,680 subtrees, about 8,000 entries)
/// is planned within the 30-second deadline by status checks, a move onto
/// main and the reviewed merge — trees are written in batches, not one Git
/// process per directory. The deadline is not raised.
#[test]
fn thousands_of_distinct_subtrees_fit_the_pr_deadline() {
    let k = Kb::new("deep-subtrees");
    let owner = k.store.owner();
    let author = k.principal(&[Permission::Propose]);
    const N: usize = 320;
    let path = |i: usize| -> String {
        let dirs: Vec<String> = (0..24).map(|d| format!("d{i}x{d}")).collect();
        format!("{}/doc.md", dirs.join("/"))
    };
    let docs = |f: &dyn Fn(usize) -> String| -> Vec<(String, Vec<u8>)> {
        (0..N).map(|i| (path(i), f(i).into_bytes())).collect()
    };
    let own = |name: &str, who: &LocalPrincipal, tip: &Sha| {
        k.git.set_ref(name, tip.as_str());
        let guard = k
            .store
            .lock_write(std::slice::from_ref(&k.kb))
            .expect("fixture");
        rusqlite::Connection::open(k.store.paths().state_db())
            .expect("fixture")
            .execute(
                "INSERT INTO branch_owners VALUES (?1, ?2, ?3, 'USER', 'fixture')",
                (k.kb.as_str(), name, who.actor_key()),
            )
            .expect("fixture");
        drop(guard);
    };
    let base = deep_commit(
        &k,
        &docs(&|i| format!("# Doc {i}\n\none\ntwo\nthree\n")),
        &[k.main.as_str()],
    );
    let main = deep_commit(
        &k,
        &docs(&|i| format!("# Doc {i}\n\nONE\ntwo\nthree\n")),
        &[base.as_str()],
    );
    // Prepare the graph independently of the operations being timed.
    k.git.set_ref("refs/heads/main", main.as_str());
    rusqlite::Connection::open(k.store.paths().state_db())
        .expect("fixture")
        .execute(
            "UPDATE kbs SET head_sha=?2 WHERE id=?1",
            (k.kb.as_str(), main.as_str()),
        )
        .expect("fixture head");
    let head = deep_commit(
        &k,
        &docs(&|i| format!("# Doc {i}\n\none\ntwo\nTHREE\n")),
        &[base.as_str()],
    );
    own("refs/heads/author/deep", &author, &head);
    // One pack is a durable seed; timed calls do not inherit dirty fixture
    // inodes or run unrelated fast-forward journals against their PR budget.
    k.git.git(&[
        "-c",
        "core.fsync=pack,pack-metadata",
        "-c",
        "core.fsyncMethod=fsync",
        "repack",
        "-a",
    ]);
    let pack_dir = k.git.repo.join("objects/pack");
    for dir in [&pack_dir, &k.git.repo.join("objects"), &k.git.repo] {
        kb_local::paths::sync_dir(dir).expect("durable fixture entries");
    }
    let started = Instant::now();
    // Status at creation: line merges of every document and the merged tree.
    let pr = k
        .store
        .pull_requests_create(
            &author,
            input::<PullRequestsCreate>(json!({
                "kbId":k.kb,"headBranch":"author/deep","expectedHeadSha":head,
                "expectedTargetSha":main,"title":"Deep","idempotencyKey":"deep-author-create"
            })),
        )
        .expect("create within the deadline")
        .pr;
    assert_eq!(pr.status, PrStatus::Open);
    // A move onto main (rebase planning rebuilds every changed subtree).
    let moved = k
        .try_edit_pr(
            &author,
            &main,
            "deep-author-move",
            edit("create", "note.md", "n"),
            pr.number,
            &head,
        )
        .expect("move onto main within the deadline");
    assert_eq!(
        moved.proposal.as_ref().map(|p| p.base_sha.clone()),
        Some(main.clone())
    );
    let viewed = k.get(pr.number, None).pr;
    assert_eq!(viewed.status, PrStatus::Open);
    let merged = k
        .review(&owner, &viewed, "merge", "deep-author-merge-key")
        .expect("merge within the deadline");
    assert_eq!(merged.pr.status, PrStatus::Merged);
    assert_eq!(
        k.git.git(&["show", &format!("{}:{}", k.head(), path(319))]),
        "# Doc 319\n\nONE\ntwo\nTHREE"
    );
    assert!(
        started.elapsed() < Duration::from_secs(90),
        "{:?}",
        started.elapsed()
    );
}

/// R3 review, one consent rule: a request against main overwrites a path
/// the caller's PR changed — a fresh conflict here, document or asset — only
/// by naming the PR with the head it read; otherwise nothing is applied.
#[test]
fn overwriting_any_pr_changed_path_requires_naming_the_pr() {
    // Document: main and the PR change the same document (a fresh conflict).
    let (k, pr, main, author) = clashing_pr_by("consent-document");
    let unnamed = k
        .try_edit(
            &author,
            &main,
            "consent-doc-unnamed",
            edit("replace", "shared.md", "mine\n"),
            None,
        )
        .expect_err("unnamed overwrite");
    assert_eq!(unnamed.protocol_details()["reason"], "PROPOSAL_CONFLICT");
    assert_eq!(k.get(pr.number, None).pr.head_sha, pr.head_sha);
    // A base equal to the PR head is no substitute for either selector.
    for (number, observed) in [
        (None, None),
        (Some(pr.number), None),
        (None, Some(pr.head_sha.clone())),
    ] {
        let mut request = json!({
            "kbId": k.kb, "baseRevision": pr.head_sha, "mode":"edit", "title":"consent",
            "idempotencyKey": format!("consent-direct-{}-{}", number.unwrap_or(0), observed.is_some()),
            "proposalNumber": number, "proposalHeadSha": observed,
            "changes": edit("replace", "shared.md", "mine\n"), "sourceSessionIds":[]
        });
        request
            .as_object_mut()
            .expect("object")
            .retain(|_, v| !v.is_null());
        let error = k
            .store
            .changes_apply(&author, input::<ChangesApply>(request))
            .expect_err("both selectors required even at the PR head");
        assert_eq!(error.protocol_details()["reason"], "PROPOSAL_CONFLICT");
    }
    let named = k
        .try_edit_pr(
            &author,
            &main,
            "consent-doc-named1",
            edit("replace", "shared.md", "mine\n"),
            pr.number,
            &pr.head_sha,
        )
        .expect("named overwrite");
    assert_eq!(named.proposal.map(|p| p.status), Some(PrStatus::Open));

    // Asset put/remove share the rule for ordinary, fresh and recorded paths.
    for clashing in [false, true] {
        let k = Kb::new(if clashing {
            "consent-asset-clash"
        } else {
            "consent-asset"
        });
        let author = k.principal(&[Permission::Propose]);
        let owner = k.store.owner();
        let shared = include_str!("../../../../../packages/api/src/lib/kb/fixtures/media-bytes.ts");
        let encoded = shared
            .split("export function minimalPng(): Buffer {")
            .nth(1)
            .expect("fixture")
            .split('"')
            .nth(1)
            .expect("PNG");
        let bytes = STANDARD.decode(encoded).expect("PNG bytes");
        let stage = |who: &LocalPrincipal, key: &str| {
            let upload = k.store.upload_begin(who,input::<UploadBegin>(json!({
                "kbId":k.kb,"kind":"asset","size":bytes.len(),"contentHash":kb_client::snapshot::content_hash(&bytes),
                "mime":"image/png","idempotencyKey":key
            }))).expect("staging");
            k.store.upload_write(who,input::<UploadWrite>(json!({"kbId":k.kb,"uploadId":upload.upload_id,"offset":0,"bytesBase64":encoded}))).expect("frame");
            k.store
                .upload_finish(
                    who,
                    input::<UploadFinish>(json!({"kbId":k.kb,"uploadId":upload.upload_id})),
                )
                .expect("READY");
            upload.upload_id
        };
        let uploaded = stage(&author, "consent-asset-upload1");
        let put = k.store.assets_put(&author,input::<AssetsPut>(json!({
            "kbId":k.kb,"baseRevision":k.main,"idempotencyKey":"consent-asset-put-01","path":"media/photo.png","uploadId":uploaded
        }))).expect("proposed asset");
        let pr = put.proposal.expect("proposal");
        let main = if clashing {
            k.store.assets_put(&owner,input::<AssetsPut>(json!({
                "kbId":k.kb,"baseRevision":k.main,"idempotencyKey":"consent-asset-main-1","path":"media/PHOTO.png","uploadId":stage(&owner,"consent-owner-upload1")
            }))).expect("main asset").commit_sha
        } else {
            k.edit(
                &owner,
                &k.main,
                "consent-asset-main-1",
                edit("create", "plain.md", "p"),
            )
            .commit_sha
        };
        let replacement = stage(&author, "consent-asset-upload2");
        let operations = [
            json!([{"op":"assetRemove","path":"media/photo.png"}]),
            json!([{"op":"assetPut","path":"media/photo.png","uploadId":replacement}]),
        ];
        for (i, change) in operations.iter().enumerate() {
            let error = k
                .try_edit(
                    &author,
                    &main,
                    &format!("consent-asset-unnamed-{i}"),
                    change.clone(),
                    None,
                )
                .expect_err("unnamed overwrite");
            assert_eq!(error.protocol_details()["reason"], "PROPOSAL_CONFLICT");
            assert_eq!(k.get(pr.number, None).pr.head_sha, pr.head_sha);
        }
        let mut observed = pr.head_sha.clone();
        if clashing {
            // Resolve the main-side case variant first, recording the PR asset.
            let step = k
                .try_edit_pr(
                    &author,
                    &main,
                    "consent-record-step1",
                    json!([{"op":"assetRemove","path":"media/PHOTO.png"}]),
                    pr.number,
                    &observed,
                )
                .expect("partial resolution");
            assert_eq!(
                step.proposal.as_ref().map(|p| p.status),
                Some(PrStatus::Conflict)
            );
            observed = step.commit_sha;
            for (i, change) in operations.iter().enumerate() {
                for (j, base) in [&main, &observed].iter().enumerate() {
                    let error = k
                        .try_edit(
                            &author,
                            base,
                            &format!("consent-record-unnamed-{i}-{j}"),
                            change.clone(),
                            None,
                        )
                        .expect_err("recorded asset needs consent");
                    assert_eq!(error.protocol_details()["reason"], "PROPOSAL_CONFLICT");
                }
            }
        }
        let named = k
            .try_edit_pr(
                &author,
                &main,
                "consent-asset-named1",
                operations[0].clone(),
                pr.number,
                &observed,
            )
            .expect("named asset write");
        assert_eq!(named.proposal.map(|p| p.status), Some(PrStatus::Open));
    }
}

/// R3 review: promotion installs an indexed pack. An
/// interrupted install leaves no journal row and no blocked name: the next
/// attempt publishes, even with Git's temporary garbage left in place.
#[test]
fn an_interrupted_promotion_leaves_nothing_visible_and_retries() {
    let (k, pr, _, author) = clashing_pr_by("promotion-interrupted");
    let owner = k.store.owner();
    // Resolve the clash so the PR merges (a real merge commit to promote).
    let main = k.head();
    k.try_edit_pr(
        &author,
        &main,
        "promotion-resolve-01",
        edit("replace", "shared.md", "both\n"),
        pr.number,
        &pr.head_sha,
    )
    .expect("resolution");
    k.edit(
        &owner,
        &main,
        "promotion-main-key-1",
        edit("create", "later.md", "l"),
    );
    let viewed = k.get(pr.number, None).pr;
    let req = serde_json::to_value(k.review_input(&viewed, "merge", "promotion-merge-key1"))
        .expect("fixture");
    let wrapper = parked_git::ParkedGit::new(&k.git.root, "index-pack");
    let intents = |k: &Kb| k.store.intents(&k.kb).expect("fixture").len();
    let before = intents(&k);
    let mut child = PolicyChild::new(&k, "review", req.clone(), Some(&wrapper.path));
    child.start();
    wrapper.wait("mark");
    let pid = std::fs::read_to_string(wrapper.bin.join("pid")).expect("Git PID");
    #[cfg(unix)]
    assert!(
        Command::new("kill")
            .args(["-KILL", pid.trim()])
            .status()
            .expect("kill Git by PID")
            .success()
    );
    #[cfg(windows)]
    assert!(
        Command::new("taskkill.exe")
            .args(["/F", "/PID", pid.trim()])
            .status()
            .expect("kill Git by PID")
            .success()
    );
    assert_eq!(
        child.wait("RESULT:", Duration::from_secs(30)),
        "RESULT:STORAGE_UNAVAILABLE"
    );
    drop(child);
    assert_eq!(intents(&k), before, "no journal-visible state");
    assert_eq!(k.head(), viewed.target_sha);
    let merged = k
        .store
        .pull_requests_review(&owner, input::<PullRequestsReview>(req))
        .expect("retry publishes");
    assert_eq!(merged.pr.status, PrStatus::Merged);
}

/// Interrupt the real pack stream during index-pack, after complete objects
/// have already arrived. No object from that failed graph may become visible.
#[test]
fn a_truncated_pack_exposes_no_partial_graph_and_retries() {
    let (k, pr, _, author) = clashing_pr_by("pack-truncated");
    let owner = k.store.owner();
    let main = k.head();
    k.try_edit_pr(
        &author,
        &main,
        "pack-truncated-resolve",
        edit("replace", "shared.md", "both\n"),
        pr.number,
        &pr.head_sha,
    )
    .expect("resolve");
    k.edit(
        &owner,
        &main,
        "pack-truncated-main",
        edit("create", "later.md", "later"),
    );
    let viewed = k.get(pr.number, None).pr;
    let request =
        serde_json::to_value(k.review_input(&viewed, "merge", "pack-truncated-merge")).unwrap();
    let before = object_set(&k);
    let intents = k.store.intents(&k.kb).unwrap().len();
    let wrapper = parked_git::ParkedGit::new(&k.git.root, "truncate-pack");
    let mut child = PolicyChild::new(&k, "review", request.clone(), Some(&wrapper.path));
    child.start();
    assert_eq!(
        child.wait("RESULT:", Duration::from_secs(30)),
        "RESULT:STORAGE_UNAVAILABLE"
    );
    assert!(
        wrapper.bin.join("truncated-pack").exists(),
        "real pack was truncated during installation"
    );
    drop(child);
    assert_eq!(object_set(&k), before, "no partial graph is visible");
    assert_eq!(k.store.intents(&k.kb).unwrap().len(), intents);
    assert_eq!(k.head(), viewed.target_sha);
    // Recovery owns all unfinished pack files because index-pack ran in scratch.
    drop(k.store.lock_write(std::slice::from_ref(&k.kb)).unwrap());
    assert!(
        std::fs::read_dir(k.git.root.join("store/uploads"))
            .unwrap()
            .all(|e| !e
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("publish-"))
    );
    let merged = k
        .store
        .pull_requests_review(&owner, input::<PullRequestsReview>(request))
        .expect("retry");
    assert_eq!(merged.pr.status, PrStatus::Merged);
    // A crash after linking a complete pack but before its index leaves only
    // an invisible orphan; recovery reclaims it and preserves indexed packs.
    let packs = k.git.repo.join("objects/pack");
    let orphan = packs.join(format!("pack-{}.pack", "e".repeat(40)));
    let complete = std::fs::read_dir(&packs)
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|e| e == "pack"))
        .unwrap();
    std::fs::copy(complete, &orphan).unwrap();
    drop(k.store.lock_write(std::slice::from_ref(&k.kb)).unwrap());
    assert!(!orphan.exists());
    assert_eq!(k.head(), merged.pr.merge_commit_sha.unwrap());
}

/// R3 review: a store path containing `:` (a path-list delimiter) plans and
/// publishes; the disposable store reaches the canonical one through its
/// `info/alternates` file.
#[cfg(unix)]
#[test]
fn store_paths_with_colons_publish() {
    let mut git = Fixture::new("colon");
    let store = Store::open(&git.root.join("store:with-colon")).expect("store");
    let out = store
        .bases_create(
            &store.owner(),
            input::<BasesCreate>(json!({
                "name":"Colon KB", "slug":"colon", "description":"Store path with a colon",
                "idempotencyKey":"colon-kb-create-0001"
            })),
        )
        .expect("kb");
    git.repo = store.paths().repo_dir(&out.kb.id);
    let k = Kb {
        store,
        git,
        kb: out.kb.id,
        main: out.kb.head_sha,
    };
    let pr = k.propose(&k.principal(&[Permission::Propose]), "topic.md");
    let main = k
        .edit(
            &k.store.owner(),
            &k.main,
            "colon-main-key-0001",
            edit("create", "human.md", "h"),
        )
        .commit_sha;
    let viewed = k.get(pr.number, None).pr;
    assert_eq!((viewed.status, &viewed.target_sha), (PrStatus::Open, &main));
    let merged = k
        .review(&k.store.owner(), &viewed, "merge", "colon-merge-key-001")
        .expect("merge");
    assert_eq!(merged.pr.status, PrStatus::Merged);
}

/// A newline cannot be represented in Git's line-based alternates file.
#[cfg(unix)]
#[test]
fn store_paths_with_newlines_fail_with_a_typed_error() {
    let git = Fixture::new("newline");
    let store = Store::open(&git.root.join("store\nnewline")).expect("store");
    let out = store
        .bases_create(
            &store.owner(),
            input::<BasesCreate>(json!({
                "name":"Newline KB", "slug":"newline", "description":"Path fixture",
                "idempotencyKey":"newline-create-001"
            })),
        )
        .expect("KB");
    let error = store
        .changes_apply(
            &store.owner(),
            input::<ChangesApply>(json!({
                "kbId":out.kb.id,"baseRevision":out.kb.head_sha,"mode":"edit","title":"test",
                "idempotencyKey":"newline-edit-001", "sourceSessionIds":[],
                "changes":edit("create","a.md","a")
            })),
        )
        .expect_err("unrepresentable alternates path");
    assert!(matches!(error, StoreError::UnsafePath(_)));
    assert_eq!(error.protocol_code(), ErrorCode::RepairRequired);
}
