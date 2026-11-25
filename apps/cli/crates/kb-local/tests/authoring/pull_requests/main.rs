//! Task 54 contract-first tests: real Git graphs, live authority, pinned
//! complete diffs and crash-recoverable one-ref merge publication.
#[path = "../../support/fixture.rs"]
mod fixture;
use fixture::ChildGuard;
#[path = "../../support/parked_git.rs"]
mod parked_git;

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use base64::{Engine, engine::general_purpose::STANDARD};
use fixture::{Fixture, sha, with_required};
use kb_client::schema::{Direction, validate};
use kb_client::tools::{
    AssetsPut, BasesCreate, BasesUpdate, ChangesApply, DocumentsCreate, DocumentsDelete,
    DocumentsUpdate, PullRequestsCreate, PullRequestsGet, PullRequestsList, PullRequestsReview,
    Tool, UploadBegin, UploadFinish, UploadWrite,
};
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
        fixture::scratch_git()
            .arg("--git-dir")
            .arg(fixture::git_spelling(&k.git.repo))
            .args(["hash-object", "-w", "--no-filters", "--stdin-paths"])
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

mod lifecycle;
mod merges;
mod planning;
mod publication;
mod recovery;
