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

#[path = "../../support/temp_dir.rs"]
mod temp_dir;
use temp_dir::TestDir;

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
#[path = "../../support/child_guard.rs"]
mod child_guard;
#[path = "../../support/scratch_git.rs"]
mod scratch_git;
use child_guard::ChildGuard;
use scratch_git::scratch_git;
use std::time::{Duration, Instant};

use kb_client::ErrorCode;
use kb_client::decode_input;
use kb_client::schema::{Direction, validate};
use kb_client::tools::{
    BasesCreate, ChangesApply, DocumentsCreate, DocumentsDelete, DocumentsGet, DocumentsUpdate,
    Tool,
};
use kb_client::types::{
    ApplyKind, ApplyResult, ChangesApplyInput, KbId, KbPath, Permission, PrStatus, Sha,
};
use kb_local::{LocalPrincipal, Phase, PrincipalKind, Stage, Store, StoreError};
use serde_json::{Value, json};

// ── Fixtures ────────────────────────────────────────────────────────────────

fn temp_root(tag: &str) -> TestDir {
    let base = temp_dir::unique_path(&format!("kb-local-changes-{tag}"));
    std::fs::create_dir_all(&base).expect("base");
    TestDir::new(base).child("store")
}

fn git(repo: &Path, args: &[&str]) -> String {
    let out = scratch_git()
        .current_dir(repo)
        .arg("--git-dir")
        .arg(".")
        .args(args)
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

fn git_with_input(repo: &Path, args: &[&str], input: &[u8]) -> String {
    let mut child = ChildGuard::new(
        scratch_git()
            .current_dir(repo)
            .arg("--git-dir")
            .arg(".")
            .args(args)
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
    // Raw `pack-objects` writes the pack before its index. Hold the store
    // fence like the real installer: a concurrent reader's recovery removes
    // any pack it finds without an index (a crash leftover under the fence).
    let fence = kb
        .store
        .lock_write(std::slice::from_ref(&kb.kb))
        .expect("fixture pack fence");
    let prefix = scratch_git::git_spelling(&kb.repo.join("objects/pack/pack"));
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
    drop(fence);
    head
}

thread_local! {
    static ROLLUP_FREE_BYTES: std::cell::Cell<u64> = const { std::cell::Cell::new(u64::MAX / 4) };
}

mod atomic;
mod crash;
mod proposals;
mod provenance;
mod rollups;
