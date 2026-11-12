//! Local atomic edits (`knowledge_changes_apply` edit mode and
//! the single-document wrappers) and proposal ownership.
//!
//! Written from the chunk prompt and CONTRACT "Atomic changes": <=32 changes,
//! complete-target-HEAD `baseRevision`, upfront validation (an invalid last
//! change has zero effects), one commit and optional one PR, identical
//! replacement = durable noop, write -> main, propose-only -> auto-PR keyed
//! actor + KB, explicit proposal stays a proposal, OPEN/CONFLICT reuse,
//! immutable CLOSED/MERGED, per-KB numbering, nondefault never schedules
//! index work. Every output is checked against the shared kb/1 schema.
//!
//! Crash tests re-execute this binary in a child role (`child_role_entry`),
//! park it at a publication stage and SIGKILL it.

#[path = "support/temp_dir.rs"]
mod temp_dir;
use temp_dir::TestDir;

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
#[path = "support/child_guard.rs"]
mod child_guard;
use child_guard::ChildGuard;
use std::time::{Duration, Instant};

use kb_client::ErrorCode;
use kb_client::decode_input;
use kb_client::schema::{Direction, validate};
use kb_client::types::{
    ApplyKind, ApplyResult, BasesCreate, ChangesApply, ChangesApplyInput, DocumentsCreate,
    DocumentsDelete, DocumentsGet, DocumentsUpdate, KbId, KbPath, Permission, PrStatus, Sha, Tool,
};
use kb_local::{LocalPrincipal, Phase, PrincipalKind, Stage, Store, StoreError};
use serde_json::{Value, json};

// ── Fixtures ────────────────────────────────────────────────────────────────

fn temp_root(tag: &str) -> TestDir {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let base = std::env::temp_dir().join(format!(
        "kb-local-changes-{tag}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&base).expect("base");
    TestDir::new(base).child("store")
}

fn git(repo: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(repo)
        .arg("--git-dir")
        .arg(".")
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .stdin(Stdio::null())
        .output()
        .expect("git");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout)
        .expect("utf8")
        .trim()
        .to_owned()
}

/// Every ref of the repository as `name sha` lines (sorted by Git).
fn refs(repo: &Path) -> String {
    git(repo, &["for-each-ref", "--format=%(refname) %(objectname)"])
}

fn rev_count(repo: &Path, rev: &str) -> usize {
    git(repo, &["rev-list", "--count", rev])
        .parse()
        .expect("count")
}

fn sha(text: &str) -> Sha {
    Sha::parse(text).expect("sha")
}

fn wire<T: Tool>(output: &T::Output) -> Value {
    let value = serde_json::to_value(output).expect("serialize");
    if let Err(violation) = validate(T::NAME.as_str(), Direction::Output, &value) {
        panic!("{} output violates the shared schema: {violation}", T::NAME);
    }
    value
}

fn input<T: Tool>(value: Value) -> T::Input {
    decode_input::<T>(value).expect("valid input")
}

struct Kb {
    store: Store,
    kb: KbId,
    main: Sha,
    repo: PathBuf,
    _root: std::rc::Rc<TestDir>,
}

fn new_kb(tag: &str) -> Kb {
    let root = temp_root(tag);
    let store = Store::open(&root).expect("open");
    let out = store
        .bases_create(
            &store.owner(),
            input::<BasesCreate>(json!({
                "name": "Changes KB",
                "slug": "changes",
                "description": "A local knowledge base for change-set tests",
                "idempotencyKey": "create-key-000000001",
            })),
        )
        .expect("create kb");
    let kb = out.kb.id.clone();
    let main = out.kb.head_sha.clone();
    let repo = store.paths().repo_dir(&kb);
    Kb {
        store,
        kb,
        main,
        repo,
        _root: std::rc::Rc::new(root),
    }
}

impl Kb {
    fn principal(&self, bits: &[Permission]) -> LocalPrincipal {
        let guard = self
            .store
            .lock_write(std::slice::from_ref(&self.kb))
            .expect("lock");
        self.store
            .register_principal(&guard, PrincipalKind::Test, &self.kb, bits)
            .expect("principal")
    }

    fn head(&self) -> Sha {
        sha(self
            .store
            .read_kb(&self.kb)
            .expect("read")
            .head_sha
            .as_deref()
            .expect("head"))
    }

    fn epoch(&self) -> i64 {
        self.store.read_kb(&self.kb).expect("read").desired_epoch
    }

    fn apply(
        &self,
        who: &LocalPrincipal,
        base: &Sha,
        key: &str,
        changes: Value,
        proposal: Option<u64>,
    ) -> Result<ApplyResult, StoreError> {
        let mut body = json!({
            "kbId": self.kb.as_str(),
            "baseRevision": base.as_str(),
            "idempotencyKey": key,
            "mode": "edit",
            "title": "Edit notes",
            "changes": changes,
            "sourceSessionIds": [],
        });
        if let Some(number) = proposal {
            body["proposalNumber"] = json!(number);
        }
        self.apply_body(who, body)
    }

    /// A write naming PR `number` with the PR head it was prepared on.
    fn apply_pr(
        &self,
        who: &LocalPrincipal,
        base: &Sha,
        key: &str,
        changes: Value,
        number: u64,
        head: &Sha,
    ) -> Result<ApplyResult, StoreError> {
        let body = json!({
            "kbId": self.kb.as_str(),
            "baseRevision": base.as_str(),
            "idempotencyKey": key,
            "mode": "edit",
            "title": "Edit notes",
            "changes": changes,
            "sourceSessionIds": [],
            "proposalNumber": number,
            "proposalHeadSha": head.as_str(),
        });
        self.apply_body(who, body)
    }

    fn apply_body(&self, who: &LocalPrincipal, body: Value) -> Result<ApplyResult, StoreError> {
        // Typed but NOT schema-checked: the store must enforce the schema.
        let typed: ChangesApplyInput = serde_json::from_value(body).expect("typed input");
        let result = self.store.changes_apply(who, typed);
        if let Ok(result) = &result {
            wire::<ChangesApply>(result);
        }
        result
    }

    fn get(&self, rev: &Sha, path: &str) -> Result<String, StoreError> {
        self.store
            .documents_get(
                &self.store.owner(),
                input::<DocumentsGet>(json!({
                    "kbId": self.kb.as_str(),
                    "rev": rev.as_str(),
                    "path": path,
                })),
            )
            .map(|doc| doc.markdown)
    }

    fn journal_len(&self) -> usize {
        self.store.intents(&self.kb).expect("intents").len()
    }
}

fn create(path: &str, markdown: &str) -> Value {
    json!({ "op": "create", "path": path, "content": { "markdown": markdown } })
}

fn replace(path: &str, markdown: &str) -> Value {
    json!({ "op": "replace", "path": path, "content": { "markdown": markdown } })
}

fn delete(path: &str) -> Value {
    json!({ "op": "delete", "path": path })
}

fn code(error: &StoreError) -> ErrorCode {
    error.protocol_code()
}

/// Snapshot of everything a rejected change set must leave untouched.
fn effects(kb: &Kb) -> (String, usize, i64, Option<String>) {
    (
        refs(&kb.repo),
        kb.journal_len(),
        kb.epoch(),
        kb.store
            .proposal(&kb.kb, 1)
            .expect("proposal")
            .map(|pr| pr.head_sha.as_str().to_owned()),
    )
}

// ── Upfront validation: zero effects ───────────────────────────────────────

#[test]
fn invalid_32nd_change_has_zero_effects() {
    let kb = new_kb("eighth");
    let owner = kb.store.owner();
    let proposer = kb.principal(&[Permission::Propose]);
    let prefix: Vec<Value> = (1..=31)
        .map(|i| create(&format!("notes/n{i}.md"), &format!("# Note {i}\n")))
        .collect();
    let bad_last_changes = [
        replace("notes/missing.md", "# nope\n"),
        delete("notes/missing.md"),
        create("index.md", "# already exists\n"),
        create("notes/bad.md", "---\nkey: [unclosed\n---\nbody\n"),
        create("notes/data.txt", "plain text is not a document\n"),
        create("notes/N1.md", "# case-folds onto notes/n1.md\n"),
        json!({ "op": "create", "path": "notes/up.md",
                "content": { "uploadId": "00000000-0000-4000-8000-000000000001" } }),
        json!({ "op": "assetPut", "path": "images/a.png",
                "uploadId": "00000000-0000-4000-8000-000000000002" }),
        json!({ "op": "assetRemove", "path": "images/a.png" }),
        // Reserved before the extension check (case-folded).
        create(".Assets/x.md", "# not a document\n"),
        // Whole-tree rule: duplicate document `id` across the batch.
        create("notes/dup.md", "---\nid: n1\n---\n# dup\n"),
    ];
    let count = bad_last_changes.len();
    for (i, last) in bad_last_changes.into_iter().enumerate() {
        let mut changes = prefix.clone();
        if i == count - 1 {
            changes[0] = create("notes/n1.md", "---\nid: n1\n---\n# Note 1\n");
        }
        changes.push(last);
        for who in [&owner, &proposer] {
            let before = effects(&kb);
            let key = format!("eighth-key-{i:02}-{}", who.id().len());
            let err = kb
                .apply(who, &kb.main, &key, json!(changes), None)
                .expect_err("invalid last change");
            let expected = if matches!(i, 6 | 7) {
                // Upload/asset variants are now implemented; guessed staging
                // IDs must hide existence with NOT_FOUND (CONTRACT upload binding).
                ErrorCode::NotFound
            } else if i == 2 {
                // Creating an existing path is a CONFLICT.
                ErrorCode::Conflict
            } else {
                ErrorCode::InvalidArgument
            };
            assert_eq!(code(&err), expected, "case {i}: {err:?}");
            // Closed reason + JSON pointer of the offending change.
            let details = err.protocol_details();
            let want = match i {
                0 | 1 => Some(("PATH_NOT_FOUND", Some("/changes/31/path"))),
                2 => Some(("PATH_EXISTS", Some("/changes/31/path"))),
                3 => Some(("INVALID_FRONT_MATTER", Some("/changes/31/content/markdown"))),
                4 => Some(("NOT_MARKDOWN_PATH", Some("/changes/31/path"))),
                // The schema's batch-wide case-fold rule names the second spelling.
                5 => Some(("PATH_CASE_COLLISION", Some("/changes/31/path"))),
                9 => Some(("RESERVED_PATH", Some("/changes/31/path"))),
                10 => Some(("DUPLICATE_DOCUMENT_ID", None)),
                _ => None,
            };
            if let Some((reason, field)) = want {
                assert_eq!(details["reason"], reason, "case {i}: {details}");
                if let Some(field) = field {
                    assert_eq!(details["field"], field, "case {i}: {details}");
                }
            }
            assert_eq!(
                effects(&kb),
                before,
                "case {i}: no ref/journal/epoch/PR effect"
            );
        }
    }
    // Over-cap calls have zero effects and explain how to split the batch.
    let batch: Vec<_> = (0..33)
        .map(|i| create(&format!("notes/b{i}.md"), "# Body\n"))
        .collect();
    let err = kb
        .apply(&owner, &kb.main, "over-cap-changes-key", json!(batch), None)
        .expect_err("33 changes");
    assert_eq!(code(&err), ErrorCode::InvalidArgument);
    assert_eq!(
        err.protocol_details(),
        json!({"reason": "TOO_MANY_CHANGES", "field": "/changes", "max": 32})
    );
    assert_eq!(kb.journal_len(), 1, "only the create receipt");
    // The same key then publishes a valid batch of 32 as ONE commit.
    let mut valid_batch = prefix;
    valid_batch.push(create("notes/n32.md", "# Note 32\n"));
    let result = kb
        .apply(
            &owner,
            &kb.main,
            "eighth-key-00-36",
            json!(valid_batch),
            None,
        )
        .expect("valid 32");
    assert_eq!(result.kind, ApplyKind::Applied);
    assert_eq!(result.changed_paths.len(), 32);
    assert_eq!(
        rev_count(&kb.repo, "refs/heads/main"),
        2,
        "exactly one commit"
    );
    assert_eq!(
        kb.get(&result.commit_sha, "notes/n8.md").expect("n8"),
        "# Note 8\n"
    );
}

#[test]
fn rejections_carry_d14_reason_and_field() {
    let kb = new_kb("reasons");
    let owner = kb.store.owner();
    let created = kb
        .apply(
            &owner,
            &kb.main,
            "reasons-key-000001",
            json!([create("caps.md", "# caps\n")]),
            None,
        )
        .expect("create caps");
    let head = created.commit_sha;
    let cases = [
        // Case-folds onto an existing document (whole-tree rule).
        (
            create("CAPS.md", "# CAPS\n"),
            json!({"reason": "PATH_CASE_COLLISION", "field": "/changes/0/path"}),
        ),
        (
            create("bad.md", "---\nkey: [unclosed\n---\nbody\n"),
            json!({"reason": "INVALID_FRONT_MATTER", "field": "/changes/0/content/markdown"}),
        ),
        (
            create("ctl.md", "# bell \u{7}\n"),
            json!({"reason": "CONTROL_CHARACTER", "field": "/changes/0/content/markdown"}),
        ),
    ];
    for (i, (change, want)) in cases.into_iter().enumerate() {
        let err = kb
            .apply(
                &owner,
                &head,
                &format!("reasons-key-{i:06}x"),
                json!([change]),
                None,
            )
            .expect_err("rejected");
        assert_eq!(code(&err), ErrorCode::InvalidArgument, "case {i}: {err:?}");
        assert_eq!(err.protocol_details(), want, "case {i}");
    }
}

#[test]
fn omitted_edit_title_is_generated_and_replays_like_the_explicit_summary() {
    let kb = new_kb("generated-title");
    let mut body = json!({"kbId":kb.kb,"baseRevision":kb.main,"idempotencyKey":"generated-title-00001","mode":"edit","changes":[create("new.md", "# New\n")]});
    let result = kb
        .store
        .changes_apply(&kb.store.owner(), input::<ChangesApply>(body.clone()))
        .expect("titleless edit");
    assert_eq!(
        git(
            &kb.repo,
            &["show", "-s", "--format=%s", result.commit_sha.as_str()]
        ),
        "kb: Create new.md"
    );
    body["title"] = json!("Create new.md");
    let replay = kb
        .store
        .changes_apply(&kb.store.owner(), input::<ChangesApply>(body))
        .expect("normalized replay");
    assert_eq!(result, replay);
}

#[test]
fn empty_edit_is_rejected_and_identical_replacement_is_a_durable_noop() {
    let kb = new_kb("noop");
    let owner = kb.store.owner();
    let err = kb
        .apply(&owner, &kb.main, "empty-edit-key-0001", json!([]), None)
        .expect_err("empty edit");
    assert_eq!(code(&err), ErrorCode::InvalidArgument);
    assert_eq!(kb.journal_len(), 1);

    let index = kb.get(&kb.main, "index.md").expect("index");
    let epoch = kb.epoch();
    let noop = kb
        .apply(
            &owner,
            &kb.main,
            "noop-key-000000001",
            json!([replace("index.md", &index)]),
            None,
        )
        .expect("noop");
    assert_eq!(noop.kind, ApplyKind::Noop);
    assert_eq!(
        noop.commit_sha, kb.main,
        "commitSha is the unchanged target"
    );
    assert_eq!(noop.base_revision, kb.main);
    assert!(noop.changed_paths.is_empty());
    assert_eq!(noop.proposal, None);
    assert_eq!(noop.index_job_id, None);
    assert_eq!(rev_count(&kb.repo, "refs/heads/main"), 1, "no commit");
    assert_eq!(kb.epoch(), epoch, "no index intent");
    // Durable receipt: replay returns the identical result; a different
    // body under the key is a mismatch.
    let rows = kb.store.intents(&kb.kb).expect("intents");
    let row = rows
        .iter()
        .find(|row| row.idempotency_key == "noop-key-000000001")
        .expect("receipt row");
    assert_eq!(row.phase, Phase::Finalized);
    assert_eq!(row.op_id, noop.operation_id);
    let again = kb
        .apply(
            &owner,
            &kb.main,
            "noop-key-000000001",
            json!([replace("index.md", &index)]),
            None,
        )
        .expect("replay");
    assert_eq!(again, noop);
    let err = kb
        .apply(
            &owner,
            &kb.main,
            "noop-key-000000001",
            json!([replace("index.md", "# x\n")]),
            None,
        )
        .expect_err("mismatch");
    assert_eq!(code(&err), ErrorCode::IdempotencyMismatch);

    // A propose-only noop opens no proposal and allocates no number.
    let proposer = kb.principal(&[Permission::Propose]);
    let noop = kb
        .apply(
            &proposer,
            &kb.main,
            "noop-key-000000002",
            json!([replace("index.md", &index)]),
            None,
        )
        .expect("proposer noop");
    assert_eq!(noop.kind, ApplyKind::Noop);
    assert_eq!(noop.proposal, None);
    let first = kb
        .apply(
            &proposer,
            &kb.main,
            "noop-key-000000003",
            json!([create("a.md", "# a\n")]),
            None,
        )
        .expect("first proposal");
    assert_eq!(
        first.proposal.expect("pr").number,
        1,
        "no number was burned"
    );
}

// ── Idempotency and base revision ──────────────────────────────────────────

#[test]
fn same_key_replays_and_mismatches_per_operation() {
    let kb = new_kb("replay");
    let owner = kb.store.owner();
    let changes = json!([create("notes/a.md", "# A\n"), create("notes/b.md", "# B\n")]);
    let first = kb
        .apply(
            &owner,
            &kb.main,
            "replay-key-0000001",
            changes.clone(),
            None,
        )
        .expect("apply");
    assert_eq!(first.kind, ApplyKind::Applied);
    assert_eq!(first.base_revision, kb.main);
    assert_eq!(first.proposal, None);
    let paths: Vec<&str> = first.changed_paths.iter().map(KbPath::as_str).collect();
    assert_eq!(paths, ["notes/a.md", "notes/b.md"]);
    assert_eq!(kb.head(), first.commit_sha);
    assert_eq!(
        kb.epoch(),
        2,
        "main publication advances the desired epoch once"
    );
    for _ in 0..2 {
        let again = kb
            .apply(
                &owner,
                &kb.main,
                "replay-key-0000001",
                changes.clone(),
                None,
            )
            .expect("replay");
        assert_eq!(again, first);
    }
    assert_eq!(rev_count(&kb.repo, "refs/heads/main"), 2);
    assert_eq!(kb.epoch(), 2);
    let err = kb
        .apply(
            &owner,
            &kb.main,
            "replay-key-0000001",
            json!([create("notes/c.md", "# C\n")]),
            None,
        )
        .expect_err("mismatch");
    assert_eq!(code(&err), ErrorCode::IdempotencyMismatch);
    // Compaction keeps replay and mismatch detection.
    let guard = kb.store.lock_write(&[]).expect("lock");
    kb.store.compact_receipts(&guard).expect("compact");
    drop(guard);
    assert_eq!(
        kb.apply(
            &owner,
            &kb.main,
            "replay-key-0000001",
            changes.clone(),
            None
        )
        .expect("replay after compaction"),
        first
    );
    let err = kb
        .apply(
            &owner,
            &kb.main,
            "replay-key-0000001",
            json!([delete("index.md")]),
            None,
        )
        .expect_err("mismatch after compaction");
    assert_eq!(code(&err), ErrorCode::IdempotencyMismatch);
    // The wrappers have their own key space (distinct operation).
    let doc = kb
        .store
        .documents_create(
            &owner,
            input::<DocumentsCreate>(json!({
                "kbId": kb.kb.as_str(),
                "baseRevision": first.commit_sha.as_str(),
                "idempotencyKey": "replay-key-0000001",
                "path": "notes/c.md",
                "content": { "markdown": "# C\n" },
            })),
        )
        .expect("wrapper with the same key");
    assert_eq!(doc.kind, ApplyKind::Applied);
    // A replay needs current authority: a revoked principal learns nothing.
    let proposer = kb.principal(&[Permission::Propose]);
    let main = kb.head();
    let proposed = kb
        .apply(
            &proposer,
            &main,
            "replay-key-0000002",
            json!([create("p.md", "# p\n")]),
            None,
        )
        .expect("proposed");
    let guard = kb
        .store
        .lock_write(std::slice::from_ref(&kb.kb))
        .expect("lock");
    kb.store
        .set_principal_permissions(&guard, &proposer, &kb.kb, &[])
        .expect("revoke");
    drop(guard);
    let err = kb
        .apply(
            &proposer,
            &main,
            "replay-key-0000002",
            json!([create("p.md", "# p\n")]),
            None,
        )
        .expect_err("revoked replay");
    assert_eq!(code(&err), ErrorCode::NotFound);
    assert!(proposed.proposal.is_some());
}

#[test]
fn competing_base_revisions_conflict_without_effects() {
    let kb = new_kb("base");
    let owner = kb.store.owner();
    let first = kb
        .apply(
            &owner,
            &kb.main,
            "base-key-00000001",
            json!([create("a.md", "# a\n")]),
            None,
        )
        .expect("first");
    let before = effects(&kb);
    let err = kb
        .apply(
            &owner,
            &kb.main,
            "base-key-00000002",
            json!([create("b.md", "# b\n")]),
            None,
        )
        .expect_err("stale base");
    match &err {
        StoreError::StaleBase {
            head_sha,
            proposal_number,
        } => {
            assert_eq!(head_sha, &first.commit_sha);
            assert_eq!(*proposal_number, None);
        }
        other => panic!("expected StaleBase, got {other:?}"),
    }
    assert_eq!(code(&err), ErrorCode::Conflict);
    assert_eq!(effects(&kb), before);
    // A readable but non-HEAD commit, and a foreign SHA, are both stale.
    let foreign = sha("0123456789abcdef0123456789abcdef01234567");
    for base in [&kb.main, &foreign] {
        let err = kb
            .apply(
                &owner,
                base,
                "base-key-00000003",
                json!([create("b.md", "# b\n")]),
                None,
            )
            .expect_err("stale");
        assert_eq!(code(&err), ErrorCode::Conflict);
    }
    // R3-W6: while the proposal sits on main, an edit against current main
    // applies on the proposal HEAD; only a path the proposal changed needs
    // its proposalNumber, else PROPOSAL_CONFLICT with both versions.
    let proposer = kb.principal(&[Permission::Propose]);
    let main = kb.head();
    let pr = kb
        .apply(
            &proposer,
            &main,
            "base-key-00000004",
            json!([create("p.md", "# p\n")]),
            None,
        )
        .expect("proposal");
    let on_head = kb
        .apply(
            &proposer,
            &main,
            "base-key-00000005",
            json!([create("q.md", "# q\n")]),
            None,
        )
        .expect("an edit against main reaches the proposal");
    assert_eq!(
        on_head.proposal.as_ref().map(|p| (p.number, p.version)),
        Some((1, 2))
    );
    assert_eq!(
        git(
            &kb.repo,
            &["rev-parse", &format!("{}^", on_head.commit_sha)]
        ),
        pr.commit_sha.as_str()
    );
    assert_eq!(kb.get(&on_head.commit_sha, "p.md").expect("kept"), "# p\n");
    let before = effects(&kb);
    let err = kb
        .apply(
            &proposer,
            &main,
            "base-key-00000006",
            json!([replace("p.md", "# p from main\n")]),
            None,
        )
        .expect_err("rewriting the proposal's own path against main");
    match &err {
        StoreError::ProposalConflict(conflict) => {
            assert_eq!(conflict.head_sha, main);
            assert_eq!(conflict.proposal_number, Some(1));
            assert_eq!(conflict.proposal_head_sha, on_head.commit_sha);
            assert_eq!(conflict.paths.len(), 1);
            assert_eq!(conflict.paths[0].path, "p.md");
            assert_eq!(conflict.paths[0].yours.as_deref(), Some("# p\n"));
            assert_eq!(conflict.paths[0].theirs, None);
        }
        other => panic!("expected PROPOSAL_CONFLICT, got {other:?}"),
    }
    assert_eq!(effects(&kb), before);
    // Naming the PR against main needs the head the choice was made on...
    match kb
        .apply(
            &proposer,
            &main,
            "base-key-00000007",
            json!([replace("p.md", "# p chosen\n")]),
            Some(1),
        )
        .expect_err("no observed head")
    {
        StoreError::StaleBase {
            head_sha,
            proposal_number,
        } => {
            assert_eq!(
                (head_sha, proposal_number),
                (on_head.commit_sha.clone(), Some(1))
            );
        }
        other => panic!("expected StaleBase, got {other:?}"),
    }
    // ...and a second editor holding the older head never overwrites the newer
    // edit: the stale save is refused with the current head.
    match kb
        .apply_pr(
            &proposer,
            &main,
            "base-key-00000008",
            json!([replace("p.md", "# p stale\n")]),
            1,
            &pr.commit_sha,
        )
        .expect_err("stale PR head")
    {
        StoreError::StaleBase { head_sha, .. } => assert_eq!(head_sha, on_head.commit_sha),
        other => panic!("expected StaleBase, got {other:?}"),
    }
    assert_eq!(effects(&kb), before);
    let named = kb
        .apply_pr(
            &proposer,
            &main,
            "base-key-00000009",
            json!([replace("p.md", "# p chosen\n")]),
            1,
            &on_head.commit_sha,
        )
        .expect("naming the proposal is a deliberate choice");
    assert_eq!(named.proposal.as_ref().map(|p| p.version), Some(3));
    assert_eq!(
        kb.get(&named.commit_sha, "p.md").expect("chosen"),
        "# p chosen\n"
    );
    assert_eq!(kb.get(&named.commit_sha, "q.md").expect("kept"), "# q\n");
}

// ── Proposals ──────────────────────────────────────────────────────────────

#[test]
fn propose_only_principal_gets_one_auto_proposal_and_main_never_changes() {
    let kb = new_kb("auto");
    let proposer = kb.principal(&[Permission::Propose]);
    let epoch = kb.epoch();
    let first = kb
        .apply(
            &proposer,
            &kb.main,
            "auto-key-00000001",
            json!([create("a.md", "# a\n")]),
            None,
        )
        .expect("proposed");
    assert_eq!(first.kind, ApplyKind::Proposed);
    assert_eq!(first.index_job_id, None, "nondefault never schedules index");
    let pr = first.proposal.clone().expect("proposal");
    assert_eq!(pr.number, 1);
    assert_eq!(pr.source_branch, "pr/1");
    assert_eq!(pr.status, PrStatus::Open);
    assert_eq!(pr.version, 1);
    assert_eq!(pr.base_sha, kb.main);
    assert_eq!(pr.head_sha, first.commit_sha);
    assert_eq!(pr.target_sha, kb.main);
    assert_eq!(pr.author_actor_key, proposer.actor_key());
    assert_eq!(pr.merge_commit_sha, None);
    assert_eq!(
        git(&kb.repo, &["rev-parse", "refs/heads/main"]),
        kb.main.as_str()
    );
    assert_eq!(
        git(&kb.repo, &["rev-parse", "refs/heads/pr/1"]),
        first.commit_sha.as_str()
    );
    assert_eq!(kb.head(), kb.main);
    assert_eq!(kb.epoch(), epoch);
    assert_eq!(
        kb.get(&first.commit_sha, "a.md").expect("reachable"),
        "# a\n"
    );
    // Second edit on the proposal HEAD reuses #1.
    let second = kb
        .apply_pr(
            &proposer,
            &first.commit_sha,
            "auto-key-00000002",
            json!([replace("a.md", "# a2\n")]),
            1,
            &first.commit_sha,
        )
        .expect("second");
    let pr2 = second.proposal.clone().expect("proposal");
    assert_eq!((pr2.number, pr2.version), (1, 2));
    assert_eq!(pr2.base_sha, kb.main, "original main base is kept");
    assert_eq!(
        git(&kb.repo, &["rev-parse", &format!("{}^", second.commit_sha)]),
        first.commit_sha.as_str()
    );
    assert_eq!(kb.head(), kb.main);
    assert_eq!(kb.epoch(), epoch);
    assert_eq!(kb.store.proposal(&kb.kb, 1).expect("pr"), Some(pr2));
    // A propose-only principal can never reach main, even naming none.
    assert_eq!(rev_count(&kb.repo, "refs/heads/main"), 1);
}

#[test]
fn open_and_conflict_reuse_then_a_fresh_number_after_close_or_merge() {
    let kb = new_kb("reuse");
    let proposer = kb.principal(&[Permission::Propose]);
    let first = kb
        .apply(
            &proposer,
            &kb.main,
            "reuse-key-0000001",
            json!([create("a.md", "# a\n")]),
            None,
        )
        .expect("first");
    let guard = kb
        .store
        .lock_write(std::slice::from_ref(&kb.kb))
        .expect("lock");
    kb.store
        .set_proposal_status_for_tests(&guard, &kb.kb, 1, PrStatus::Conflict)
        .expect("conflict");
    drop(guard);
    let second = kb
        .apply(
            &proposer,
            &first.commit_sha,
            "reuse-key-0000002",
            json!([create("b.md", "# b\n")]),
            None,
        )
        .expect("reuse conflict proposal");
    let pr = second.proposal.expect("pr");
    assert_eq!((pr.number, pr.version, pr.status), (1, 2, PrStatus::Open));

    for (status, expect_number, key) in [
        (PrStatus::Closed, 2, "reuse-key-0000003"),
        (PrStatus::Merged, 3, "reuse-key-0000004"),
    ] {
        let closed_number = expect_number - 1;
        let closed = kb
            .store
            .proposal(&kb.kb, closed_number)
            .expect("pr")
            .expect("pr");
        let guard = kb
            .store
            .lock_write(std::slice::from_ref(&kb.kb))
            .expect("lock");
        kb.store
            .set_proposal_status_for_tests(&guard, &kb.kb, closed_number, status)
            .expect("terminal");
        // Terminal proposals are immutable.
        let err = kb
            .store
            .set_proposal_status_for_tests(&guard, &kb.kb, closed_number, PrStatus::Open)
            .expect_err("immutable");
        assert_eq!(code(&err), ErrorCode::Conflict);
        drop(guard);
        let refs_before = refs(&kb.repo);
        // Naming one's own closed proposal is the precondition answer:
        // continue on current main (server parity); others' stay invisible.
        let err = kb
            .apply(
                &proposer,
                &closed.head_sha,
                &format!("{key}x"),
                json!([create("z.md", "# z\n")]),
                Some(closed_number),
            )
            .expect_err("closed proposal");
        match &err {
            StoreError::StaleBase {
                head_sha,
                proposal_number,
            } => assert_eq!((head_sha, *proposal_number), (&kb.head(), None)),
            other => panic!("expected StaleBase, got {other:?}"),
        }
        let stranger = kb.principal(&[Permission::Propose]);
        let err = kb
            .apply(
                &stranger,
                &closed.head_sha,
                &format!("{key}w"),
                json!([create("z.md", "# z\n")]),
                Some(closed_number),
            )
            .expect_err("someone else's closed proposal");
        assert_eq!(code(&err), ErrorCode::NotFound);
        // Its old head is no longer a valid base for an implicit edit.
        let err = kb
            .apply(
                &proposer,
                &closed.head_sha,
                &format!("{key}y"),
                json!([create("z.md", "# z\n")]),
                None,
            )
            .expect_err("closed head is stale");
        assert_eq!(code(&err), ErrorCode::Conflict);
        assert_eq!(refs(&kb.repo), refs_before);
        let fresh = kb
            .apply(
                &proposer,
                &kb.main,
                key,
                json!([create("c.md", "# c\n")]),
                None,
            )
            .expect("fresh proposal");
        let pr = fresh.proposal.expect("pr");
        assert_eq!((pr.number, pr.version), (expect_number, 1));
        assert_eq!(pr.source_branch, format!("pr/{expect_number}"));
        // The closed branch is retained and unchanged.
        assert_eq!(
            git(
                &kb.repo,
                &["rev-parse", &format!("refs/heads/pr/{closed_number}")]
            ),
            closed.head_sha.as_str()
        );
        assert_eq!(
            kb.store
                .proposal(&kb.kb, closed_number)
                .expect("pr")
                .expect("pr")
                .head_sha,
            closed.head_sha
        );
    }
    assert_eq!(kb.head(), kb.main);
}

#[test]
fn cross_actor_proposals_are_denied() {
    let kb = new_kb("cross");
    let alice = kb.principal(&[Permission::Propose]);
    let bob = kb.principal(&[Permission::Propose]);
    let owner = kb.store.owner();
    let pr = kb
        .apply(
            &alice,
            &kb.main,
            "cross-key-0000001",
            json!([create("a.md", "# a\n")]),
            None,
        )
        .expect("alice");
    let head = pr.commit_sha.clone();
    for who in [&bob, &owner] {
        let before = effects(&kb);
        let err = kb
            .apply(
                who,
                &head,
                "cross-key-0000002",
                json!([create("b.md", "# b\n")]),
                Some(1),
            )
            .expect_err("not the branch owner");
        assert_eq!(code(&err), ErrorCode::Forbidden);
        assert_eq!(effects(&kb), before);
    }
    // Bob's implicit edit opens his own proposal instead of reusing Alice's.
    let bobs = kb
        .apply(
            &bob,
            &kb.main,
            "cross-key-0000003",
            json!([create("b.md", "# b\n")]),
            None,
        )
        .expect("bob");
    let pr = bobs.proposal.expect("pr");
    assert_eq!(pr.number, 2);
    assert_eq!(pr.author_actor_key, bob.actor_key());
    // A principal without propose is forbidden; without read, NOT_FOUND.
    let reader = kb.principal(&[Permission::Read]);
    let err = kb
        .apply(
            &reader,
            &kb.main,
            "cross-key-0000004",
            json!([create("r.md", "# r\n")]),
            None,
        )
        .expect_err("read only");
    assert_eq!(code(&err), ErrorCode::Forbidden);
    let nobody = kb.principal(&[]);
    let err = kb
        .apply(
            &nobody,
            &kb.main,
            "cross-key-0000005",
            json!([create("r.md", "# r\n")]),
            None,
        )
        .expect_err("no access");
    assert_eq!(code(&err), ErrorCode::NotFound);
}

#[test]
fn explicit_proposal_stays_a_proposal_for_a_write_holder() {
    let kb = new_kb("explicit");
    let author = kb.principal(&[Permission::Propose]);
    let pr = kb
        .apply(
            &author,
            &kb.main,
            "explicit-key-00001",
            json!([create("a.md", "# a\n")]),
            None,
        )
        .expect("proposal");
    let guard = kb
        .store
        .lock_write(std::slice::from_ref(&kb.kb))
        .expect("lock");
    kb.store
        .set_principal_permissions(&guard, &author, &kb.kb, &[Permission::Write])
        .expect("raise to write");
    drop(guard);
    let updated = kb
        .apply_pr(
            &author,
            &pr.commit_sha,
            "explicit-key-00002",
            json!([replace("a.md", "# a2\n")]),
            1,
            &pr.commit_sha,
        )
        .expect("explicit proposal");
    assert_eq!(updated.kind, ApplyKind::Proposed);
    assert_eq!(updated.proposal.expect("pr").version, 2);
    assert_eq!(kb.head(), kb.main, "main untouched");
    // Without proposalNumber the write holder publishes main directly.
    let direct = kb
        .apply(
            &author,
            &kb.main,
            "explicit-key-00003",
            json!([create("d.md", "# d\n")]),
            None,
        )
        .expect("direct");
    assert_eq!(direct.kind, ApplyKind::Applied);
    assert_eq!(direct.proposal, None);
    assert_eq!(kb.head(), direct.commit_sha);
    // An unknown proposal number is NOT_FOUND.
    let err = kb
        .apply(
            &author,
            &direct.commit_sha,
            "explicit-key-00004",
            json!([create("e.md", "# e\n")]),
            Some(9),
        )
        .expect_err("unknown");
    assert_eq!(code(&err), ErrorCode::NotFound);
}

#[test]
fn document_wrappers_keep_explicit_owned_proposal_for_write_holder() {
    let kb = new_kb("wrapper-proposal");
    let author = kb.principal(&[Permission::Propose]);
    let proposal = kb
        .apply(
            &author,
            &kb.main,
            "wrapper-pr-start-01",
            json!([create("seed.md", "# seed\n")]),
            None,
        )
        .expect("proposal");
    let guard = kb
        .store
        .lock_write(std::slice::from_ref(&kb.kb))
        .expect("lock");
    kb.store
        .set_principal_permissions(&guard, &author, &kb.kb, &[Permission::Write])
        .expect("write permission");
    drop(guard);
    let mut head = proposal.commit_sha;
    let epoch = kb.epoch();
    for (step, tool) in ["create", "update", "delete"].iter().enumerate() {
        let mut value = json!({"kbId":kb.kb,"baseRevision":head,"proposalNumber":1,"proposalHeadSha":head,"idempotencyKey":format!("wrapper-pr-step-{step:03}"),"path":"owned.md"});
        if *tool == "delete" {
            value["confirm"] = json!("DELETE");
        } else {
            value["content"] = json!({"markdown":format!("# step {step}\n")});
        }
        // A main base plus a nonexistent explicit selector must never fall back to main.
        let before = effects(&kb);
        let mut invalid = value.clone();
        invalid["baseRevision"] = json!(kb.main);
        invalid["proposalNumber"] = json!(999);
        invalid["idempotencyKey"] = json!(format!("wrapper-pr-invalid-{step:03}"));
        let denied = match *tool {
            "create" => kb
                .store
                .documents_create(&author, input::<DocumentsCreate>(invalid)),
            "update" => kb
                .store
                .documents_update(&author, input::<DocumentsUpdate>(invalid)),
            _ => kb
                .store
                .documents_delete(&author, input::<DocumentsDelete>(invalid)),
        }
        .expect_err("explicit unknown proposal");
        assert_eq!(code(&denied), ErrorCode::NotFound);
        assert_eq!(effects(&kb), before);
        let result = match *tool {
            "create" => kb
                .store
                .documents_create(&author, input::<DocumentsCreate>(value)),
            "update" => kb
                .store
                .documents_update(&author, input::<DocumentsUpdate>(value)),
            _ => kb
                .store
                .documents_delete(&author, input::<DocumentsDelete>(value)),
        }
        .expect("explicit owned proposal");
        assert_eq!(result.kind, ApplyKind::Proposed);
        assert_eq!(result.proposal.expect("proposal").number, 1);
        assert_eq!(result.index_job_id, None);
        assert_eq!(kb.head(), kb.main);
        assert_eq!(kb.epoch(), epoch);
        head = result.commit_sha;
    }
}

#[test]
fn single_document_wrappers_call_the_same_service() {
    let kb = new_kb("wrappers");
    let owner = kb.store.owner();
    let write = |key: &str, base: &Sha, path: &str, body: &str, update: bool| {
        let value = json!({
            "kbId": kb.kb.as_str(),
            "baseRevision": base.as_str(),
            "idempotencyKey": key,
            "path": path,
            "content": { "markdown": body },
        });
        if update {
            let out = kb
                .store
                .documents_update(&owner, input::<DocumentsUpdate>(value));
            out.inspect(|r| {
                wire::<DocumentsUpdate>(r);
            })
        } else {
            let out = kb
                .store
                .documents_create(&owner, input::<DocumentsCreate>(value));
            out.inspect(|r| {
                wire::<DocumentsCreate>(r);
            })
        }
    };
    let created =
        write("wrap-key-000000001", &kb.main, "notes/w.md", "# w\n", false).expect("create");
    assert_eq!(created.kind, ApplyKind::Applied);
    let head = created.commit_sha.clone();
    let err = write(
        "wrap-key-000000002",
        &head,
        "notes/w.md",
        "# again\n",
        false,
    )
    .expect_err("create existing");
    assert_eq!(code(&err), ErrorCode::Conflict);
    assert_eq!(
        err.protocol_details(),
        json!({"reason": "PATH_EXISTS", "field": "/path"})
    );
    let noop = write("wrap-key-000000003", &head, "notes/w.md", "# w\n", true).expect("noop");
    assert_eq!(noop.kind, ApplyKind::Noop);
    let err = write("wrap-key-000000004", &head, "notes/none.md", "# n\n", true)
        .expect_err("update missing");
    assert_eq!(code(&err), ErrorCode::InvalidArgument);
    assert_eq!(
        err.protocol_details(),
        json!({"reason": "PATH_NOT_FOUND", "field": "/path"})
    );
    let updated = write("wrap-key-000000005", &head, "notes/w.md", "# w2\n", true).expect("update");
    assert_eq!(updated.kind, ApplyKind::Applied);
    let delete_input = |key: &str, base: &Sha, path: &str| {
        input::<DocumentsDelete>(json!({
            "kbId": kb.kb.as_str(),
            "baseRevision": base.as_str(),
            "idempotencyKey": key,
            "path": path,
            "confirm": "DELETE",
        }))
    };
    let err = kb
        .store
        .documents_delete(
            &owner,
            delete_input("wrap-key-000000006", &updated.commit_sha, "x.md"),
        )
        .expect_err("delete missing");
    assert_eq!(code(&err), ErrorCode::InvalidArgument);
    let deleted = kb
        .store
        .documents_delete(
            &owner,
            delete_input("wrap-key-000000007", &updated.commit_sha, "notes/w.md"),
        )
        .expect("delete");
    wire::<DocumentsDelete>(&deleted);
    assert_eq!(deleted.kind, ApplyKind::Applied);
    assert_eq!(
        deleted
            .changed_paths
            .iter()
            .map(KbPath::as_str)
            .collect::<Vec<_>>(),
        ["notes/w.md"]
    );
    assert_eq!(
        code(&kb.get(&deleted.commit_sha, "notes/w.md").expect_err("gone")),
        ErrorCode::NotFound
    );
    // A propose-only principal's wrapper call becomes its auto-proposal.
    let proposer = kb.principal(&[Permission::Propose]);
    let proposed = kb
        .store
        .documents_create(
            &proposer,
            input::<DocumentsCreate>(json!({
                "kbId": kb.kb.as_str(),
                "baseRevision": deleted.commit_sha.as_str(),
                "idempotencyKey": "wrap-key-000000008",
                "path": "notes/p.md",
                "content": { "markdown": "# p\n" },
            })),
        )
        .expect("proposed");
    assert_eq!(proposed.kind, ApplyKind::Proposed);
    assert_eq!(proposed.proposal.expect("pr").number, 1);
    assert_eq!(kb.head(), deleted.commit_sha);
}

// ── Crash recovery and cross-process allocation ────────────────────────────

const ROLE_ENV: &str = "KB_LOCAL_CHANGES_ROLE";
const ROOT_ENV: &str = "KB_LOCAL_CHANGES_ROOT";
const ARG_ENV: &str = "KB_LOCAL_CHANGES_ARG";

fn say(line: &str) {
    let mut out = std::io::stdout().lock();
    writeln!(out, "\n{line}").expect("stdout");
    out.flush().expect("stdout");
}

fn park_forever() -> ! {
    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    std::process::exit(9);
}

fn child_input(kb: &KbId, base: &Sha, key: &str, path: &str) -> ChangesApplyInput {
    input::<ChangesApply>(json!({
        "kbId": kb.as_str(),
        "baseRevision": base.as_str(),
        "idempotencyKey": key,
        "mode": "edit",
        "title": "Child edit",
        "changes": [create(path, "# child\n")],
        "sourceSessionIds": [],
    }))
}

#[test]
fn child_role_entry() {
    let Ok(role) = std::env::var(ROLE_ENV) else {
        return;
    };
    let root = PathBuf::from(std::env::var(ROOT_ENV).expect("root"));
    if role == "unwind-probe" {
        child_guard::unwind_probe_role(&root);
    }
    let arg = std::env::var(ARG_ENV).unwrap_or_default();
    // arg = "<stage|-> <principal> <kb> <base> <key> <path>"
    let parts: Vec<&str> = arg.split(' ').collect();
    let store = Store::open(&root).expect("open");
    let who = store.principal(parts[1]).expect("principal");
    let kb = KbId::parse(parts[2]).expect("kb");
    let request = child_input(&kb, &sha(parts[3]), parts[4], parts[5]);
    match role.as_str() {
        "apply-kill" => {
            let target = match parts[0] {
                "committing" => Stage::Committing,
                "ref-moved" => Stage::RefMoved,
                "finalizing" => Stage::Finalizing,
                other => panic!("unknown stage {other}"),
            };
            let _ = store.changes_apply_observed(&who, request, &mut |stage| {
                if stage == target {
                    say("AT");
                    park_forever();
                }
                Ok(())
            });
            say("NEVER");
            park_forever();
        }
        "apply" => match store.changes_apply(&who, request) {
            Ok(result) => say(&format!("OK {}", result.proposal.map_or(0, |pr| pr.number))),
            Err(error) => say(&format!("ERR {:?}", error.protocol_code())),
        },
        other => panic!("unknown role {other}"),
    }
}

fn spawn_role(role: &str, root: &Path, arg: &str) -> ChildGuard {
    let mut command = Command::new(std::env::current_exe().expect("exe"));
    command
        .args([
            "--exact",
            "child_role_entry",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(ROLE_ENV, role)
        .env(ROOT_ENV, root)
        .env(ARG_ENV, arg)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    ChildGuard::spawn(&command).expect("spawn child")
}

fn kill_at(child: &mut ChildGuard) {
    let stdout = child.stdout.take().expect("stdout");
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line).expect("read");
        assert!(n > 0, "child exited before its kill point");
        assert_ne!(line.trim_end(), "NEVER", "child passed its kill point");
        if line.trim_end() == "AT" {
            break;
        }
    }
    child.kill().expect("kill");
    child.wait().expect("reap");
}

#[test]
fn crash_after_proposal_ref_move_recovers_one_row_and_receipt() {
    for stage in ["ref-moved", "finalizing"] {
        let kb = new_kb(&format!("crash-{stage}"));
        let proposer = kb.principal(&[Permission::Propose]);
        let root = kb.store.paths().root().to_path_buf();
        let (kb_id, main, repo) = (kb.kb.clone(), kb.main.clone(), kb.repo.clone());
        // Close the store for restart, retaining directory ownership.
        let _fixture = kb._root;
        drop(kb.store);
        let key = "crash-key-00000001";
        let mut child = spawn_role(
            "apply-kill",
            &root,
            &format!("{stage} {} {kb_id} {main} {key} a.md", proposer.id()),
        );
        kill_at(&mut child);
        // Startup recovery is opportunistic. Force its nonblocking lock
        // attempt to defer, just as unrelated registry/spawn contention can.
        let fence = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(root.join("locks/store.lock"))
            .expect("fixture fence");
        fence.lock().expect("fixture fence");
        let store = Store::open(&root).expect("reopen while recovery is deferred");
        assert_eq!(
            store
                .intents(&kb_id)
                .expect("intents")
                .into_iter()
                .find(|row| row.idempotency_key == key)
                .expect("row")
                .phase,
            Phase::Committing,
            "startup must not recover through a held fence"
        );
        fence.unlock().expect("release fixture fence");
        let record = store.read_kb(&kb_id).expect("read-only recovery gate");
        let rows: Vec<_> = store
            .intents(&kb_id)
            .expect("intents")
            .into_iter()
            .filter(|row| row.idempotency_key == key)
            .collect();
        assert_eq!(rows.len(), 1, "{stage}: one journal row");
        assert_eq!(rows[0].phase, Phase::Finalized, "{stage}");
        assert_eq!(rows[0].ref_name, "refs/heads/pr/1");
        let pr = store.proposal(&kb_id, 1).expect("pr").expect("one PR row");
        assert_eq!(pr.version, 1);
        assert_eq!(pr.status, PrStatus::Open);
        assert_eq!(store.proposal(&kb_id, 2).expect("pr"), None);
        assert_eq!(
            git(&repo, &["rev-parse", "refs/heads/pr/1"]),
            pr.head_sha.as_str()
        );
        assert_eq!(git(&repo, &["rev-parse", "refs/heads/main"]), main.as_str());
        assert_eq!(record.head_sha.as_deref(), Some(main.as_str()));
        assert_eq!(record.desired_epoch, 1, "no index intent for a proposal");
        let replay = store
            .changes_apply(&proposer, child_input(&kb_id, &main, key, "a.md"))
            .expect("replay the recovered receipt");
        wire::<ChangesApply>(&replay);
        assert_eq!(replay.kind, ApplyKind::Proposed);
        assert_eq!(replay.operation_id, rows[0].op_id);
        assert_eq!(replay.commit_sha, pr.head_sha);
        assert_eq!(replay.proposal, Some(pr.clone()));
        // The next edit reuses #1.
        let next = store
            .changes_apply(
                &proposer,
                child_input(&kb_id, &pr.head_sha, "crash-key-00000002", "b.md"),
            )
            .expect("next");
        assert_eq!(next.proposal.expect("pr").number, 1);
    }
}

#[test]
fn crash_before_proposal_ref_move_aborts_without_burning_a_number() {
    let kb = new_kb("crash-committing");
    let proposer = kb.principal(&[Permission::Propose]);
    let root = kb.store.paths().root().to_path_buf();
    let (kb_id, main, repo) = (kb.kb.clone(), kb.main.clone(), kb.repo.clone());
    // Close the store for restart, retaining directory ownership.
    let _fixture = kb._root;
    drop(kb.store);
    let key = "crash-key-00000003";
    let mut child = spawn_role(
        "apply-kill",
        &root,
        &format!("committing {} {kb_id} {main} {key} a.md", proposer.id()),
    );
    kill_at(&mut child);
    let store = Store::open(&root).expect("reopen");
    let record = store.read_kb(&kb_id).expect("read-only recovery gate");
    assert_eq!(record.head_sha.as_deref(), Some(main.as_str()));
    assert_eq!(
        record.desired_epoch, 1,
        "aborted proposal has no index effect"
    );
    let row = store
        .intents(&kb_id)
        .expect("intents")
        .into_iter()
        .find(|row| row.idempotency_key == key)
        .expect("row");
    assert_eq!(row.phase, Phase::Aborted);
    assert_eq!(store.proposal(&kb_id, 1).expect("pr"), None);
    assert!(!refs(&repo).contains("refs/heads/pr/"), "no proposal ref");
    let err = store
        .changes_apply(&proposer, child_input(&kb_id, &main, key, "a.md"))
        .expect_err("stable abort");
    assert!(matches!(err, StoreError::OperationAborted(_)), "{err:?}");
    let fresh = store
        .changes_apply(
            &proposer,
            child_input(&kb_id, &main, "crash-key-00000004", "a.md"),
        )
        .expect("fresh");
    assert_eq!(fresh.proposal.expect("pr").number, 1);
}

#[test]
fn two_processes_serialize_proposal_number_allocation() {
    let kb = new_kb("alloc");
    let a = kb.principal(&[Permission::Propose]);
    let b = kb.principal(&[Permission::Propose]);
    let root = kb.store.paths().root().to_path_buf();
    let (kb_id, main, repo) = (kb.kb.clone(), kb.main.clone(), kb.repo.clone());
    // Close the store for restart, retaining directory ownership.
    let _fixture = kb._root;
    drop(kb.store);
    let children: Vec<ChildGuard> = [(&a, "alloc-key-000000a"), (&b, "alloc-key-000000b")]
        .into_iter()
        .map(|(who, key)| {
            spawn_role(
                "apply",
                &root,
                &format!("- {} {kb_id} {main} {key} {}.md", who.id(), &key[15..]),
            )
        })
        .collect();
    // Drain every concurrently spawned child before a result assertion can panic.
    let outputs: Vec<_> = children
        .into_iter()
        .map(ChildGuard::wait_with_output)
        .collect();
    let mut numbers = Vec::new();
    for output in outputs {
        let output = output.expect("wait");
        assert!(output.status.success());
        for line in String::from_utf8(output.stdout).expect("utf8").lines() {
            if let Some(n) = line.strip_prefix("OK ") {
                numbers.push(n.parse::<u64>().expect("number"));
            }
            assert!(!line.starts_with("ERR"), "{line}");
        }
    }
    numbers.sort_unstable();
    assert_eq!(numbers, [1, 2], "distinct, gap-free numbers");
    let store = Store::open(&root).expect("reopen");
    let authors: Vec<String> = [1, 2]
        .iter()
        .map(|n| {
            store
                .proposal(&kb_id, *n)
                .expect("pr")
                .expect("pr")
                .author_actor_key
        })
        .collect();
    assert!(authors.contains(&a.actor_key()) && authors.contains(&b.actor_key()));
    assert_eq!(git(&repo, &["rev-parse", "refs/heads/main"]), main.as_str());
    assert_eq!(refs(&repo).lines().count(), 3, "main + pr/1 + pr/2");
}

#[test]
fn encoded_frontmatter_rejection_has_zero_effects_and_valid_boundary_is_readable() {
    let kb = new_kb("frontmatter-wire");
    let proposer = kb.principal(&[Permission::Propose]);
    let oversized = format!("---\nk: \"{}\"\n---\nbody\n", "\t".repeat(40_000));
    let mut numeric_yaml = String::new();
    let mut numeric_json = String::from("{");
    for i in 0..3000 {
        numeric_yaml.push_str(&format!("n{i}: 1e-6\n"));
        numeric_json.push_str(&format!("\"n{i}\":0.000001,"));
    }
    numeric_json.push_str("\"padding\":\"\"}");
    let numeric_padding = 64 * 1024 - numeric_json.len();
    let oversized_numeric = format!(
        "---\n{numeric_yaml}padding: '{}'\n---\nbody\n",
        "a".repeat(numeric_padding + 1)
    );
    for invalid in [&oversized, &oversized_numeric] {
        for who in [&kb.store.owner(), &proposer] {
            let before = effects(&kb);
            let next_pr = || {
                let db = rusqlite::Connection::open(kb.store.paths().root().join("state.sqlite"))
                    .unwrap();
                db.query_row(
                    "SELECT next_pr_number FROM kbs WHERE id = ?1",
                    [kb.kb.as_str()],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap()
            };
            let counter = next_pr();
            let err = kb
                .apply(
                    who,
                    &kb.main,
                    "encoded-frontmatter-key",
                    json!([create("large.md", invalid)]),
                    None,
                )
                .unwrap_err();
            assert_eq!(err.protocol_code(), ErrorCode::InvalidArgument);
            assert_eq!(effects(&kb), before);
            assert_eq!(next_pr(), counter);
        }
    }
    let valid = format!("---\nk: '{}'\n---\nbody\n", "\t".repeat(32764));
    let result = kb
        .apply(
            &kb.store.owner(),
            &kb.main,
            "encoded-frontmatter-key",
            json!([create("large.md", &valid)]),
            None,
        )
        .unwrap();
    let doc = kb
        .store
        .documents_get(
            &kb.store.owner(),
            input::<DocumentsGet>(
                json!({"kbId":kb.kb, "rev":result.commit_sha, "path":"large.md"}),
            ),
        )
        .unwrap();
    wire::<DocumentsGet>(&doc);
    assert_eq!(doc.markdown, valid);
    assert_eq!(
        serde_json::to_vec(&doc.front_matter).unwrap().len(),
        64 * 1024
    );
    let valid_numeric = format!(
        "---\n{numeric_yaml}padding: '{}'\n---\nbody\n",
        "a".repeat(numeric_padding)
    );
    let numeric = kb
        .apply(
            &kb.store.owner(),
            &result.commit_sha,
            "numeric-frontmatter-key",
            json!([create("numeric.md", &valid_numeric)]),
            None,
        )
        .unwrap();
    let doc = kb
        .store
        .documents_get(
            &kb.store.owner(),
            input::<DocumentsGet>(
                json!({"kbId":kb.kb, "rev":numeric.commit_sha, "path":"numeric.md"}),
            ),
        )
        .unwrap();
    wire::<DocumentsGet>(&doc);
    assert_eq!(doc.markdown, valid_numeric);
    assert_eq!(doc.front_matter["n0"], json!(1e-6));
    assert_eq!(
        doc.front_matter["padding"].as_str().unwrap().len(),
        numeric_padding
    );
    assert!(
        serde_json::to_vec(&doc.front_matter).unwrap().len() < 64 * 1024,
        "serde's shorter number spelling must not define the portable cap"
    );
}

// ── Object consolidation ────────────────────────────────────────────────────

/// `git_write::CONSOLIDATE_PACKS`: a write's lock acquisition rolls up the
/// small packs of its KB's repository once it holds this many.
const CONSOLIDATE_PACKS: usize = 8;

fn pack_names(repo: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(repo.join("objects/pack"))
        .expect("packs")
        .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn indexed_pack_count(repo: &Path) -> usize {
    pack_names(repo)
        .iter()
        .filter(|n| n.starts_with("pack-") && n.ends_with(".idx"))
        .count()
}

/// Every object name in the repository (packed and loose).
fn all_objects(repo: &Path) -> std::collections::BTreeSet<String> {
    git(
        repo,
        &[
            "cat-file",
            "--batch-all-objects",
            "--batch-check=%(objectname)",
        ],
    )
    .lines()
    .map(str::to_owned)
    .collect()
}

fn git_with_input(repo: &Path, args: &[&str], input: &[u8]) -> String {
    let mut child = ChildGuard::new(
        Command::new("git")
            .current_dir(repo)
            .arg("--git-dir")
            .arg(".")
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("git"),
    );
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(input)
        .expect("write");
    let out = child.wait_with_output().expect("git");
    assert!(out.status.success(), "git {args:?}");
    String::from_utf8(out.stdout)
        .expect("utf8")
        .trim()
        .to_owned()
}

/// An unreachable loose blob.
fn loose_blob(repo: &Path, body: &[u8]) -> String {
    git_with_input(repo, &["hash-object", "-w", "--stdin"], body)
}

/// Batch fixture creation avoids a Git process and durability barrier per blob.
fn loose_blob_batch(repo: &Path, count: usize) -> Vec<String> {
    let inputs = repo.join("fixture-inputs");
    std::fs::create_dir(&inputs).expect("fixture directory");
    let mut list = String::new();
    for n in 0..count {
        let path = inputs.join(n.to_string());
        std::fs::write(&path, format!("tiny fixture blob {n}\n")).expect("fixture body");
        list.push_str(path.to_str().expect("utf8 path"));
        list.push('\n');
    }
    let input_list = inputs.join("paths");
    std::fs::write(&input_list, list).expect("fixture list");
    // File-fed stdin lets output() drain all the hashes while Git reads the
    // paths; writing a large list synchronously to a pipe can deadlock.
    let out = Command::new("git")
        .arg("--git-dir")
        .arg(repo)
        .args([
            "-c",
            "core.fsync=none",
            "hash-object",
            "-w",
            "--stdin-paths",
        ])
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .stdin(std::fs::File::open(input_list).expect("fixture list"))
        .output()
        .expect("git hash-object");
    assert!(out.status.success());
    let names = String::from_utf8(out.stdout).expect("object names");
    std::fs::remove_dir_all(inputs).expect("fixture cleanup");
    names.lines().map(str::to_owned).collect()
}

/// An extra pack holding one new unreachable blob (raises the pack count
/// without a publication or a lock).
fn extra_pack(repo: &Path, body: &[u8]) -> String {
    let sha = loose_blob(repo, body);
    let prefix = repo.join("objects/pack/pack");
    git_with_input(
        repo,
        &["pack-objects", "-q", prefix.to_str().expect("utf8")],
        format!("{sha}\n").as_bytes(),
    );
    git(repo, &["prune-packed"]);
    sha
}

/// Publish through the core service (including its publication lock), then
/// make one fixture pack, just as changes_apply's staging installer does.
/// These maintenance fixtures do not test changes_apply's validation deadline:
/// disk admission/packing/fsync/pruning can legitimately take longer on CI.
fn publish(kb: &Kb, head: &Sha, key: &str, path: &str) -> Sha {
    let head = kb
        .store
        .commit_files(
            &kb.store.owner(),
            kb_local::CommitRequest {
                kb: kb.kb.clone(),
                base_revision: head.clone(),
                idempotency_key: key.into(),
                changes: vec![kb_local::FileChange {
                    path: path.into(),
                    content: Some(format!("# {path}\n").into_bytes()),
                }],
            },
        )
        .expect("publish")
        .commit_sha;
    let prefix = kb.repo.join("objects/pack/pack");
    git_with_input(
        &kb.repo,
        &[
            "pack-objects",
            "--revs",
            "--unpacked",
            "-q",
            prefix.to_str().expect("utf8"),
        ],
        format!("{head}\n").as_bytes(),
    );
    git(&kb.repo, &["prune-packed", "-q"]);
    head
}

/// Publish until the repository holds `CONSOLIDATE_PACKS` packs: the state
/// right after a publication, before the next lock rolls them up.
fn publish_to_threshold(kb: &Kb, head: &mut Sha, tag: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let mut i = 0;
    while indexed_pack_count(&kb.repo) < CONSOLIDATE_PACKS {
        assert!(i < 2 * CONSOLIDATE_PACKS, "one pack per publication");
        let path = format!("notes/{tag}{i}.md");
        *head = publish(kb, head, &format!("{tag}-key-{i:06}"), &path);
        paths.push(path);
        i += 1;
    }
    paths
}

/// Functional assertions exercise the real fold and cleanup with the
/// maintenance clock/admission controlled. Real budget kills live in recovery.
fn maintain_now(kb: &Kb) {
    let guard = kb
        .store
        .lock_write(std::slice::from_ref(&kb.kb))
        .expect("maintenance fence");
    for _ in 0..128 {
        if !kb
            .store
            .consolidate_now_for_tests(&guard)
            .expect("maintenance")
        {
            return;
        }
    }
    panic!("bounded cleanup batches did not finish");
}

/// Phase P review: one pack per publication and no Git maintenance made
/// every Git spawn slower without bound; the first fix rewrote the whole
/// repository. Rollups are geometric: the pack count stays bounded, a large
/// pack is never rewritten, no object (reachable or not) is lost, a reader
/// that already mapped the old packs keeps resolving every object, and
/// concurrent kb-local reads stay correct throughout.
#[test]
fn pack_count_stays_bounded_and_reads_stay_correct_across_rollups() {
    let kb = new_kb("pack-bound");
    // A large unreachable pack at the freeze size (`CONSOLIDATE_FROZEN_BYTES`,
    // 16 MiB): never counted toward a rollup and never rewritten.
    let frozen = 16 << 20;
    let mut noise = Vec::with_capacity(frozen + 4096);
    let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
    while noise.len() < frozen + 4096 {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        noise.extend_from_slice(&x.to_le_bytes());
    }
    let big_blob = extra_pack(&kb.repo, &noise);
    let big_pack = pack_names(&kb.repo)
        .into_iter()
        .find(|n| n.ends_with(".pack"))
        .expect("large pack");
    let big_inode = std::fs::metadata(kb.repo.join("objects/pack").join(&big_pack)).unwrap();
    // A long-lived raw reader that maps every pack as it appears.
    let mut reader = ChildGuard::new(
        Command::new("git")
            .current_dir(&kb.repo)
            .args(["--git-dir", ".", "cat-file", "--batch-check"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("reader"),
    );
    let mut reader_in = reader.stdin.take().expect("stdin");
    let mut reader_out = BufReader::new(reader.stdout.take().expect("stdout"));
    let mut ask_all = |reader_in: &mut std::process::ChildStdin| {
        for name in all_objects(&kb.repo) {
            writeln!(reader_in, "{name}").expect("ask");
            let mut line = String::new();
            reader_out.read_line(&mut line).expect("answer");
            assert!(!line.ends_with("missing\n"), "live reader lost {name}");
        }
    };
    ask_all(&mut reader_in);
    let first = publish(&kb, &kb.main, "pack-bound-key-000000", "notes/n0.md");
    // Concurrent kb-local reads of the first document at its first commit.
    let root = kb.store.paths().root().to_path_buf();
    // One concurrent read per publication. A busy reader loop can monopolize
    // lock admission on a loaded host and keeps running if the publisher
    // panics; channel closure stops this reader on every exit path.
    std::thread::scope(|scope| {
        let (requests, requested) = std::sync::mpsc::channel::<()>();
        let (completed, completions) = std::sync::mpsc::channel::<()>();
        let concurrent = {
            let (kb_id, rev) = (kb.kb.clone(), first.clone());
            scope.spawn(move || {
                let store = Store::open(&root).expect("reader store");
                let mut reads = 0usize;
                while requested.recv().is_ok() {
                    let got = store.documents_get(
                        &store.owner(),
                        input::<DocumentsGet>(json!({
                            "kbId": kb_id.as_str(), "rev": rev.as_str(), "path": "notes/n0.md",
                        })),
                    );
                    match got {
                        Ok(doc) => {
                            assert_eq!(doc.markdown, "# notes/n0.md\n", "read stays correct")
                        }
                        // Lock admission may be busy behind a publication.
                        Err(e) => assert!(
                            matches!(
                                code(&e),
                                ErrorCode::DeadlineExceeded | ErrorCode::StorageUnavailable
                            ),
                            "unexpected read failure {e:?}"
                        ),
                    }
                    reads += 1;
                    let _ = completed.send(());
                }
                reads
            })
        };
        let mut revisions = vec![(first.clone(), 0usize)];
        let mut head = first;
        let (mut rolled, mut last) = (false, indexed_pack_count(&kb.repo));
        for i in 1..4 * CONSOLIDATE_PACKS {
            // The reader maps the current packs before the next rollup.
            ask_all(&mut reader_in);
            requests.send(()).expect("concurrent read requested");
            maintain_now(&kb);
            head = publish(
                &kb,
                &head,
                &format!("pack-bound-key-{i:06}"),
                &format!("notes/n{i}.md"),
            );
            completions.recv().expect("concurrent read finished");
            revisions.push((head.clone(), i));
            let packs = indexed_pack_count(&kb.repo);
            // The frozen pack plus at most the threshold of small ones.
            assert!(packs <= CONSOLIDATE_PACKS + 1, "{packs} packs after {i}");
            rolled |= packs < last;
            last = packs;
        }
        drop(requests);
        assert!(concurrent.join().expect("reader thread") > 0);
        assert!(rolled, "rollups ran");
        // The large pack was never rewritten.
        let still = std::fs::metadata(kb.repo.join("objects/pack").join(&big_pack))
            .expect("large pack kept");
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(still.ino(), big_inode.ino(), "large pack untouched");
        }
        let _ = (still, big_inode);
        ask_all(&mut reader_in);
        drop(reader_in);
        assert!(reader.wait().expect("reader").success());
        assert!(
            all_objects(&kb.repo).contains(&big_blob),
            "unreachable object retained"
        );
        for (rev, i) in &revisions {
            assert_eq!(
                kb.get(rev, &format!("notes/n{i}.md"))
                    .expect("historical read"),
                format!("# notes/n{i}.md\n")
            );
        }
        git(&kb.repo, &["fsck", "--full", "--no-dangling"]);
        assert!(
            !std::fs::read_dir(kb.store.paths().uploads_dir())
                .expect("uploads")
                .any(|e| e
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("publish-")),
            "no rollup scratch left"
        );
        assert_eq!(kb.store.pack_consolidation(&kb.kb).unwrap(), None);
    });
}

/// Loose objects alone (direct writes, aborted operations) trigger a rollup
/// at Git's `gc.auto` sample; they are packed, kept and pruned as loose.
#[test]
fn loose_object_sample_triggers_a_rollup_that_keeps_every_object() {
    let kb = new_kb("pack-loose");
    let mut sampled = Vec::new();
    let mut n = 0u64;
    while sampled.len() < 27 {
        let body = format!("loose {n}\n");
        n += 1;
        let header = format!("blob {}\0", body.len());
        let digest = ring::digest::digest(
            &ring::digest::SHA1_FOR_LEGACY_USE_ONLY,
            &[header.as_bytes(), body.as_bytes()].concat(),
        );
        if digest.as_ref()[0] == 0x17 {
            sampled.push(loose_blob(&kb.repo, body.as_bytes()));
        }
    }
    assert!(indexed_pack_count(&kb.repo) < CONSOLIDATE_PACKS);
    let objects = all_objects(&kb.repo);
    maintain_now(&kb);
    let fan = kb.repo.join("objects/17");
    assert_eq!(
        std::fs::read_dir(&fan).map(|d| d.count()).unwrap_or(0),
        0,
        "sampled loose objects were packed and pruned"
    );
    assert!(all_objects(&kb.repo).is_superset(&objects));
    for sha in &sampled {
        assert!(objects.contains(sha));
    }
    git(&kb.repo, &["fsck", "--full", "--no-dangling"]);
}

#[test]
fn scheduled_rollup_progresses_with_many_genuinely_unpacked_objects() {
    let kb = new_kb("rollup-mixed");
    for n in 0..32 {
        extra_pack(&kb.repo, format!("mixed pack {n}\n").as_bytes());
    }
    let loose = loose_blob_batch(&kb.repo, 12_000);
    let before = all_objects(&kb.repo);
    assert_eq!(indexed_pack_count(&kb.repo), 32);
    drop(
        kb.store
            .lock_publication(std::slice::from_ref(&kb.kb))
            .unwrap(),
    );
    // Scheduled work may defer anywhere in its wall-clock budget. Assert
    // functional completion through the controlled maintenance seam below.
    // Fsync/installation may consume the pass's budget. The regression is
    // useful folding under scheduled admission, not a deadline for every
    // selected unlink. A later cleanup must reuse that installed coverage.
    if let Some(deferred) = kb.store.pack_consolidation(&kb.kb).unwrap() {
        assert_eq!(deferred.code, "DEADLINE_EXCEEDED");
    }
    maintain_now(&kb);
    // A pre-install intent is discarded without retirement; its next pass
    // performs the fold from the preserved originals.
    maintain_now(&kb);
    assert!(
        indexed_pack_count(&kb.repo) < 32,
        "controlled fold makes progress"
    );
    let installed = pack_names(&kb.repo);
    maintain_now(&kb);
    assert_eq!(
        pack_names(&kb.repo),
        installed,
        "completed cleanup does not repack"
    );
    assert!(
        loose.iter().any(|sha| {
            !kb.repo
                .join("objects")
                .join(&sha[..2])
                .join(&sha[2..])
                .exists()
        }),
        "cleanup makes on-disk progress"
    );
    assert!(all_objects(&kb.repo).is_superset(&before));
    git(&kb.repo, &["fsck", "--full", "--no-dangling"]);
}

thread_local! {
    static ROLLUP_FREE_BYTES: std::cell::Cell<u64> = const { std::cell::Cell::new(u64::MAX / 4) };
}
fn rollup_disk_budget(_: &kb_local::StorePaths, _: &Path) -> Result<u64, StoreError> {
    Ok(ROLLUP_FREE_BYTES.get())
}

#[test]
fn rollup_admission_includes_the_count_dense_pack_index_before_scratch() {
    let kb = new_kb("rollup-index-budget");
    let names = loose_blob_batch(&kb.repo, 52_000);
    for chunk in names.chunks(6_500) {
        git_with_input(
            &kb.repo,
            &[
                "pack-objects",
                "-q",
                kb.repo.join("objects/pack/pack").to_str().unwrap(),
            ],
            format!("{}\n", chunk.join("\n")).as_bytes(),
        );
    }
    git(&kb.repo, &["prune-packed", "-q"]);
    let before = pack_names(&kb.repo);
    let input_bytes: u64 = before
        .iter()
        .filter(|name| name.ends_with(".pack"))
        .map(|name| {
            std::fs::metadata(kb.repo.join("objects/pack").join(name))
                .unwrap()
                .len()
        })
        .sum();
    let objects_before = all_objects(&kb.repo);
    let loose_bytes = git(&kb.repo, &["count-objects", "-v"])
        .lines()
        .find_map(|line| {
            line.strip_prefix("size: ")
                .map(|n| n.parse::<u64>().unwrap() * 1024)
        })
        .unwrap();
    let old_allowance = input_bytes + loose_bytes + (1 << 20) + 4096;
    kb.store.set_disk_meter_for_tests(rollup_disk_budget);
    ROLLUP_FREE_BYTES.set((1 << 30) + old_allowance);
    maintain_now(&kb);
    assert_eq!(
        pack_names(&kb.repo),
        before,
        "old files remain and no replacement was installed"
    );
    assert_eq!(
        kb.store.pack_consolidation(&kb.kb).unwrap().unwrap().code,
        "QUOTA_EXCEEDED"
    );
    assert_eq!(
        std::fs::read_dir(kb.store.paths().uploads_dir())
            .unwrap()
            .count(),
        0,
        "admission precedes scratch creation"
    );
    // v2 SHA-1 index upper bound, including a large-offset entry per object.
    let index_bound = 1072 + objects_before.len() as u64 * 36;
    // The durable cleanup intent coexists with the index and all originals.
    let intent_bound = objects_before.len() as u64 * 128 + (8 + 20_000) * 1024;
    ROLLUP_FREE_BYTES.set((1 << 30) + old_allowance + index_bound + intent_bound);
    maintain_now(&kb);
    assert_eq!(kb.store.pack_consolidation(&kb.kb).unwrap(), None);
    assert_eq!(indexed_pack_count(&kb.repo), 1);
    let installed_bytes: u64 = pack_names(&kb.repo)
        .iter()
        .filter(|name| name.ends_with(".pack") || name.ends_with(".idx"))
        .map(|name| {
            std::fs::metadata(kb.repo.join("objects/pack").join(name))
                .unwrap()
                .len()
        })
        .sum();
    assert!(
        installed_bytes > old_allowance,
        "the omitted index would spend the disk floor"
    );
    assert!(
        installed_bytes <= input_bytes + loose_bytes + (1 << 20) + index_bound,
        "the full replacement fits while all original files still coexist"
    );
    assert!(all_objects(&kb.repo).is_superset(&objects_before));
    git(&kb.repo, &["fsck", "--full", "--no-dangling"]);
}

static NO_DISK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
fn toggled_disk(_: &kb_local::StorePaths, _: &Path) -> Result<u64, StoreError> {
    Ok(if NO_DISK.load(std::sync::atomic::Ordering::Acquire) {
        0
    } else {
        u64::MAX / 4
    })
}

/// A rollup without disk headroom is deferred: the lock still succeeds, the
/// store is unchanged and valid, the deferral is recorded durably, and the
/// next locks do not repeat its cost until the pressure has grown by the
/// back-off step; a later success clears the record.
#[test]
fn a_deferred_rollup_backs_off_and_never_fails_the_lock() {
    let kb = new_kb("pack-defer");
    kb.store.set_disk_meter_for_tests(toggled_disk);
    let mut head = kb.main.clone();
    publish_to_threshold(&kb, &mut head, "defer");
    let before = pack_names(&kb.repo);
    NO_DISK.store(true, std::sync::atomic::Ordering::Release);
    maintain_now(&kb);
    assert_eq!(pack_names(&kb.repo), before, "nothing changed");
    let deferred = kb
        .store
        .pack_consolidation(&kb.kb)
        .unwrap()
        .expect("recorded");
    assert_eq!(deferred.code, "QUOTA_EXCEEDED");
    assert_eq!(deferred.deferrals, 1);
    // Back-off: further locks do not retry below the next level.
    for _ in 0..3 {
        drop(
            kb.store
                .lock_publication(std::slice::from_ref(&kb.kb))
                .unwrap(),
        );
    }
    assert_eq!(
        kb.store.pack_consolidation(&kb.kb).unwrap(),
        Some(deferred.clone())
    );
    let mut extra = 0;
    while (kb
        .store
        .pack_consolidation(&kb.kb)
        .unwrap()
        .unwrap()
        .deferrals
        == 1)
        && extra < 4 * CONSOLIDATE_PACKS
    {
        extra_pack(&kb.repo, format!("pressure {extra}\n").as_bytes());
        extra += 1;
        drop(
            kb.store
                .lock_publication(std::slice::from_ref(&kb.kb))
                .unwrap(),
        );
    }
    let again = kb.store.pack_consolidation(&kb.kb).unwrap().unwrap();
    assert_eq!(again.deferrals, 2, "retried once the pressure grew");
    assert!(again.level >= deferred.retry_level());
    assert!(again.retry_level() - again.level > deferred.retry_level() - deferred.level);
    git(&kb.repo, &["fsck", "--full", "--no-dangling"]);
    // With headroom back, the next due retry succeeds and clears the record.
    NO_DISK.store(false, std::sync::atomic::Ordering::Release);
    maintain_now(&kb);
    assert!(indexed_pack_count(&kb.repo) < CONSOLIDATE_PACKS);
    assert_eq!(
        kb.get(&head, "notes/defer0.md").expect("read"),
        "# notes/defer0.md\n"
    );
}

/// Five failed attempts formerly shrank the cap to 1 MiB. All the packs
/// here are ~600 KiB, with no loose objects: that cap could fold only one,
/// and "nothing to fold" kept the KB stuck forever. Retry spacing must
/// recover without changing the cap or weakening its freeze bound.
#[test]
fn a_rollup_makes_progress_after_five_injected_failures() {
    let kb = new_kb("pack-progress");
    let mut random = 0x2545_f491_4f6c_dd1du64;
    for i in 0..9 {
        let blob: Vec<u8> = (0..600 * 1024)
            .map(|_| {
                random ^= random << 13;
                random ^= random >> 7;
                random ^= random << 17;
                random as u8
            })
            .collect();
        // Build fixture packs without per-blob durability barriers. The
        // production rollup below still performs every file/directory sync.
        let sha = git_with_input(
            &kb.repo,
            &["-c", "core.fsync=none", "hash-object", "-w", "--stdin"],
            &blob,
        );
        git_with_input(
            &kb.repo,
            &[
                "pack-objects",
                "-q",
                kb.repo.join("objects/pack/pack").to_str().unwrap(),
            ],
            format!("{sha}\n").as_bytes(),
        );
        if i == 0 {
            // Put the initial KB objects in a >512 KiB pack as well.
            git(&kb.repo, &["repack", "-ad", "--keep-unreachable"]);
        }
    }
    git(&kb.repo, &["prune-packed", "-q"]);
    assert!(
        pack_names(&kb.repo)
            .iter()
            .filter(|n| n.ends_with(".pack"))
            .all(|n| {
                std::fs::metadata(kb.repo.join("objects/pack").join(n))
                    .unwrap()
                    .len()
                    > 512 * 1024
            })
    );
    let before = indexed_pack_count(&kb.repo);
    let all = all_objects(&kb.repo);
    let guard = kb.store.lock_write(std::slice::from_ref(&kb.kb)).unwrap();
    kb.store.set_disk_meter_for_tests(|_, _| Ok(0));
    for failures in 1..=5 {
        kb.store
            .consolidate_now_for_tests(&guard)
            .expect("deferred fold");
        let row = kb
            .store
            .pack_consolidation(&kb.kb)
            .unwrap()
            .expect("failure");
        assert_eq!(row.deferrals, failures);
        assert_eq!(row.code, "QUOTA_EXCEEDED");
        assert_eq!(indexed_pack_count(&kb.repo), before);
    }
    kb.store.set_disk_meter_for_tests(|_, _| Ok(u64::MAX / 4));
    kb.store
        .consolidate_now_for_tests(&guard)
        .expect("progress");
    assert!(
        indexed_pack_count(&kb.repo) < before,
        "full-cap retry folded the small packs"
    );
    assert_eq!(kb.store.pack_consolidation(&kb.kb).unwrap(), None);
    assert!(
        indexed_pack_count(&kb.repo) < 8,
        "returned to a bounded steady state"
    );
    assert_eq!(all_objects(&kb.repo), all, "no objects lost");
    git(&kb.repo, &["fsck", "--full", "--no-dangling"]);
    drop(guard);
}

/// Retry history must also recover when there is nothing left to fold.
/// Previously five failures meant a sticky 1 MiB cap, even for idle stores.
#[test]
fn a_repository_with_no_rollup_work_clears_old_failures() {
    let kb = new_kb("pack-idle");
    // Seed packs directly: the behavior under test is retry settlement,
    // independent of publication deadlines on a busy disk.
    for i in 0..CONSOLIDATE_PACKS {
        extra_pack(&kb.repo, format!("idle pack {i}\n").as_bytes());
    }
    let all = all_objects(&kb.repo);
    let guard = kb.store.lock_write(std::slice::from_ref(&kb.kb)).unwrap();
    kb.store.set_disk_meter_for_tests(|_, _| Ok(0));
    for _ in 0..5 {
        kb.store.consolidate_now_for_tests(&guard).unwrap();
    }
    assert_eq!(
        kb.store
            .pack_consolidation(&kb.kb)
            .unwrap()
            .unwrap()
            .deferrals,
        5
    );
    // Offline maintenance can resolve the pressure while its old deferral
    // remains. Exercise the real publication lock with that durable history.
    git(&kb.repo, &["repack", "-ad", "--keep-unreachable"]);
    git(&kb.repo, &["prune-packed", "-q"]);
    let before = pack_names(&kb.repo);
    assert_eq!(indexed_pack_count(&kb.repo), 1);
    drop(guard);
    drop(
        kb.store
            .lock_publication(std::slice::from_ref(&kb.kb))
            .unwrap(),
    );
    assert_eq!(kb.store.pack_consolidation(&kb.kb).unwrap(), None);
    assert_eq!(pack_names(&kb.repo), before, "no fold attempted");
    assert_eq!(all_objects(&kb.repo), all);
    git(&kb.repo, &["fsck", "--full", "--no-dangling"]);
}

/// A write to one KB never rolls up another KB's repository, and neither
/// does opening the store; the other KB's own next write does.
#[test]
fn rollups_run_only_for_the_written_kb() {
    let a = new_kb("pack-cross");
    let b_id = a
        .store
        .bases_create(
            &a.store.owner(),
            input::<BasesCreate>(json!({
                "name": "Other KB",
                "slug": "other",
                "description": "A second knowledge base in the same store",
                "idempotencyKey": "create-key-000000002",
            })),
        )
        .expect("second kb")
        .kb;
    let b = Kb {
        store: Store::open(a.store.paths().root()).expect("second handle"),
        repo: a.store.paths().repo_dir(&b_id.id),
        kb: b_id.id,
        main: b_id.head_sha,
        _root: a._root.clone(),
    };
    let mut b_head = b.main.clone();
    publish_to_threshold(&b, &mut b_head, "cross");
    let before = pack_names(&b.repo);
    publish(&a, &a.main, "cross-a-key-000001", "notes/a.md");
    drop(
        a.store
            .lock_publication(std::slice::from_ref(&a.kb))
            .unwrap(),
    );
    assert_eq!(pack_names(&b.repo), before, "a write to A leaves B alone");
    drop(Store::open(a.store.paths().root()).expect("reopen"));
    assert_eq!(pack_names(&b.repo), before, "store open leaves B alone");
    maintain_now(&b);
    assert!(
        indexed_pack_count(&b.repo) < CONSOLIDATE_PACKS,
        "B's own lock rolls up"
    );
}

/// The earlier sorted lock is a healthy import source. Speculative cleanup
/// must leave the maintenance slot available to the growing destination.
#[test]
fn rollup_no_work_source_does_not_starve_the_import_destination() {
    let a = new_kb("rollup-two-kbs");
    let created = a
        .store
        .bases_create(
            &a.store.owner(),
            input::<BasesCreate>(json!({
                "name": "Other KB", "slug": "other", "description": "Import destination fixture",
                "idempotencyKey": "rollup-second-0001",
            })),
        )
        .unwrap()
        .kb;
    let b = Kb {
        store: Store::open(a.store.paths().root()).unwrap(),
        repo: a.store.paths().repo_dir(&created.id),
        kb: created.id,
        main: created.head_sha,
        _root: a._root.clone(),
    };
    let (source, destination) = if a.kb.as_str() < b.kb.as_str() {
        (&a, &b)
    } else {
        (&b, &a)
    };
    for i in 0..2 {
        extra_pack(&source.repo, format!("healthy source {i}\n").as_bytes());
    }
    for i in 0..CONSOLIDATE_PACKS {
        extra_pack(
            &destination.repo,
            format!("due destination {i}\n").as_bytes(),
        );
    }
    let source_packs = pack_names(&source.repo);
    let before = all_objects(&destination.repo);
    for i in 0..12 {
        // Pass the source first as well: NoWork must advance even without the
        // destination preference. Controlled maintenance keeps fsync speed
        // separate from this functional scheduling assertion.
        let guard = a
            .store
            .lock_write(&[source.kb.clone(), destination.kb.clone()])
            .unwrap();
        a.store.consolidate_now_for_tests(&guard).unwrap();
        drop(guard);
        assert!(indexed_pack_count(&destination.repo) < CONSOLIDATE_PACKS);
        extra_pack(
            &destination.repo,
            format!("import publication {i}\n").as_bytes(),
        );
    }
    assert_eq!(pack_names(&source.repo), source_packs);
    assert!(all_objects(&destination.repo).is_superset(&before));
    assert_eq!(a.store.pack_consolidation(&destination.kb).unwrap(), None);
    git(&source.repo, &["fsck", "--full", "--no-dangling"]);
    git(&destination.repo, &["fsck", "--full", "--no-dangling"]);
}

/// Oversized loose inputs are retained under an explicit keep policy. They
/// neither stop smaller inputs nor count as work that can never be selected.
#[test]
fn rollup_skips_an_oversized_real_loose_object_and_maintains_smaller_ones() {
    let kb = new_kb("rollup-oversized");
    let mut body = vec![0u8; 17 << 20];
    let mut x = 0x2545_f491_4f6c_dd1du64;
    for byte in &mut body {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        *byte = x as u8;
    }
    // Hash the large prefix once; search the sampled fan-out by varying an
    // eight-byte suffix. The fixture stays cheap even in an unoptimized build.
    let mut prefix = ring::digest::Context::new(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY);
    prefix.update(format!("blob {}\0", body.len() + 8).as_bytes());
    prefix.update(&body);
    for n in 0u64.. {
        let nonce = n.to_le_bytes();
        let mut digest = prefix.clone();
        digest.update(&nonce);
        if digest.finish().as_ref()[0] == 0x17 {
            body.extend_from_slice(&nonce);
            break;
        }
    }
    let oversized = loose_blob(&kb.repo, &body);
    drop(body);
    let kept = kb.repo.join("objects/17").join(&oversized[2..]);
    assert!(std::fs::metadata(&kept).unwrap().len() > 16 << 20);
    let mut sampled = Vec::new();
    for n in 0.. {
        let body = format!("small after oversized {n}\n");
        let digest = ring::digest::digest(
            &ring::digest::SHA1_FOR_LEGACY_USE_ONLY,
            &[format!("blob {}\0", body.len()).as_bytes(), body.as_bytes()].concat(),
        );
        if digest.as_ref()[0] == 0x17 {
            sampled.push(loose_blob(&kb.repo, body.as_bytes()));
            if sampled.len() == 27 {
                break;
            }
        }
    }
    let before = all_objects(&kb.repo);
    maintain_now(&kb);
    for name in &sampled {
        assert!(!kb.repo.join("objects/17").join(&name[2..]).exists());
    }
    assert!(kept.exists(), "oversized object retained loose");
    let packs = pack_names(&kb.repo);
    for _ in 0..3 {
        drop(
            kb.store
                .lock_publication(std::slice::from_ref(&kb.kb))
                .unwrap(),
        );
        maintain_now(&kb);
    }
    assert_eq!(pack_names(&kb.repo), packs, "no perpetual rollup");
    assert_eq!(kb.store.pack_consolidation(&kb.kb).unwrap(), None);
    let mut head = kb.main.clone();
    for n in 0..3 {
        head = publish(
            &kb,
            &head,
            &format!("oversized-write-{n:06}"),
            &format!("notes/after-{n}.md"),
        );
        maintain_now(&kb);
    }
    assert_eq!(
        kb.head(),
        head,
        "publication continues beside the retained object"
    );
    assert!(kept.exists());
    assert!(indexed_pack_count(&kb.repo) < CONSOLIDATE_PACKS);
    assert!(all_objects(&kb.repo).is_superset(&before));
    git(&kb.repo, &["fsck", "--full", "--no-dangling"]);
}

/// A crash at any point of a rollup leaves a valid store that the next
/// pass finishes: both the new pack and every old one (crash before
/// removal), or an old data file whose index was already removed.
#[test]
fn interrupted_rollup_leaves_a_valid_store_that_the_next_pass_finishes() {
    let kb = new_kb("pack-crash");
    let mut head = kb.main.clone();
    let written = publish_to_threshold(&kb, &mut head, "crash");
    let packs = kb.repo.join("objects/pack");
    let saved = kb
        .store
        .paths()
        .root()
        .parent()
        .expect("base")
        .join("saved");
    std::fs::create_dir_all(&saved).unwrap();
    let before = pack_names(&kb.repo);
    for name in &before {
        std::fs::copy(packs.join(name), saved.join(name)).unwrap();
    }
    let objects = all_objects(&kb.repo);
    maintain_now(&kb);
    assert!(
        indexed_pack_count(&kb.repo) < CONSOLIDATE_PACKS,
        "rolled up"
    );
    // Crash before the old packs went: restore them (data before index).
    for name in before.iter().filter(|n| n.ends_with(".pack")) {
        std::fs::copy(saved.join(name), packs.join(name)).unwrap();
    }
    for name in before.iter().filter(|n| !n.ends_with(".pack")) {
        std::fs::copy(saved.join(name), packs.join(name)).unwrap();
    }
    // ...and one old pack had already lost its index.
    let orphan = before
        .iter()
        .find(|n| n.ends_with(".idx"))
        .expect("an old index")
        .clone();
    std::fs::remove_file(packs.join(&orphan)).unwrap();
    git(&kb.repo, &["fsck", "--full", "--no-dangling"]);
    assert!(all_objects(&kb.repo).is_superset(&objects));
    assert_eq!(
        kb.get(&head, &written[0]).expect("read"),
        format!("# {}\n", written[0])
    );
    assert!(indexed_pack_count(&kb.repo) >= CONSOLIDATE_PACKS);
    maintain_now(&kb);
    assert!(
        indexed_pack_count(&kb.repo) < CONSOLIDATE_PACKS,
        "next pass finished it"
    );
    assert!(
        !pack_names(&kb.repo).contains(&orphan.replace(".idx", ".pack")),
        "unindexed data file removed"
    );
    assert!(all_objects(&kb.repo).is_superset(&objects));
    git(&kb.repo, &["fsck", "--full", "--no-dangling"]);
    for path in &written {
        assert_eq!(kb.get(&head, path).expect("read"), format!("# {path}\n"));
    }
}

/// Removing an unindexed pack can fail for reasons other than permissions
/// (a Windows sharing violation; here: it is a directory). Recovery treats
/// any such failure as "not yet" and every lock still succeeds.
#[test]
fn an_unremovable_unindexed_pack_never_fails_recovery() {
    let kb = new_kb("pack-stuck");
    let stuck = kb
        .repo
        .join("objects/pack")
        .join(format!("pack-{}.pack", "e".repeat(40)));
    std::fs::create_dir(&stuck).unwrap();
    std::fs::write(stuck.join("held"), b"x").unwrap();
    for _ in 0..2 {
        drop(
            kb.store
                .lock_publication(std::slice::from_ref(&kb.kb))
                .expect("lock"),
        );
    }
    publish(&kb, &kb.main, "stuck-key-000001", "notes/s.md");
    assert!(stuck.exists());
    std::fs::remove_dir_all(&stuck).unwrap();
    drop(
        kb.store
            .lock_publication(std::slice::from_ref(&kb.kb))
            .expect("lock"),
    );
}

#[test]
fn crash_helper_unwind_drains_before_directory_removal() {
    let removed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observed = removed.clone();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut root = temp_root("unwind-writer");
        std::fs::create_dir_all(&root).expect("probe root");
        // Construction of a second child fails after the first was admitted.
        // Vec must own the first tree throughout this partial construction.
        let _children: Vec<ChildGuard> = (0..2)
            .map(|index| {
                assert_eq!(index, 0, "injected failure constructing the second child");
                let child = spawn_role("unwind-probe", &root, "");
                let pids = child_guard::writer_pids(&root);
                let path = root.to_path_buf();
                let observed = observed.clone();
                root.before_remove(move || {
                    assert!(path.exists(), "check runs before the actual rm");
                    child_guard::assert_dead(&pids);
                    observed.store(true, std::sync::atomic::Ordering::Relaxed);
                });
                child
            })
            .collect();
    }));
    assert!(result.is_err());
    assert!(removed.load(std::sync::atomic::Ordering::Relaxed));
}
