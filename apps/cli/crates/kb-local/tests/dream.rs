//! Local atomic dreams with the server's provenance rules.
//!
//! Written from the chunk prompt and CONTRACT "Atomic changes and dreaming"
//! before the implementation. The shared golden corpus
//! (`packages/api/src/lib/kb/fixtures/dream-golden.json`) was produced by the
//! TypeScript implementation and is pinned on the server side by
//! `packages/api/src/lib/kb/dream.test.ts` ("shared dream golden corpus"), so
//! identical Markdown bytes / paths / digests / result kinds here mean
//! behavior parity with the server (not tool-name equality).
//!
//! Every rejection must publish nothing: no ref, journal row, proposal row,
//! number, index epoch or Git object carrying the rejected content.

#[path = "support/temp_dir.rs"]
mod temp_dir;
use temp_dir::TestDir;

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use kb_client::ErrorCode;
use kb_client::schema::{Direction, validate};
use kb_client::types::{
    ApplyKind, ApplyResult, BasesCreate, ChangesApply, ChangesApplyInput, DocumentsGet,
    DreamMetadata, DreamUpsert, KbId, Permission, Sha, Tool, Uuid,
};
use kb_local::{LocalPrincipal, PrincipalKind, Stage, Store, StoreError, dream, sensitive_text};
use serde_json::{Value, json};

// ── Fixtures ────────────────────────────────────────────────────────────────

const S1: &str = "00000000-0000-4000-8000-000000000001";
const SECRET: &str = "sk-proj-abcdefghijklmnopqrstuvwxyz";

fn golden() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../packages/api/src/lib/kb/fixtures/dream-golden.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("golden corpus")).expect("json")
}

fn temp_root(tag: &str) -> TestDir {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let base = std::env::temp_dir().join(format!(
        "kb-local-dream-{tag}-{}-{nanos}",
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
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

fn refs(repo: &Path) -> String {
    git(repo, &["for-each-ref", "--format=%(refname) %(objectname)"])
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

struct Kb {
    store: Store,
    root: TestDir,
    kb: KbId,
    main: Sha,
    repo: PathBuf,
}

fn new_kb(tag: &str) -> Kb {
    let root = temp_root(tag);
    let store = Store::open(&root).expect("open");
    let out = store
        .bases_create(
            &store.owner(),
            kb_client::decode_input::<BasesCreate>(json!({
                "name": "Dream KB",
                "slug": "dream",
                "description": "A local knowledge base for dream tests",
                "idempotencyKey": "create-key-000000001",
            }))
            .expect("input"),
        )
        .expect("create kb");
    let kb = out.kb.id.clone();
    let main = out.kb.head_sha.clone();
    let repo = store.paths().repo_dir(&kb);
    Kb {
        root,
        store,
        kb,
        main,
        repo,
    }
}

/// Failure of a dream call: the store's error, or a typed-boundary
/// rejection (the value is not even a well-typed kb/1 input).
#[derive(Debug)]
enum Failure {
    Store(StoreError),
    Boundary,
}

impl Failure {
    fn code(&self) -> ErrorCode {
        match self {
            Failure::Store(error) => error.protocol_code(),
            Failure::Boundary => ErrorCode::InvalidArgument,
        }
    }
}

impl Kb {
    fn reopen(self) -> Kb {
        let Kb {
            root,
            store,
            kb,
            main,
            repo,
        } = self;
        drop(store);
        let store = Store::open(&root).expect("reopen");
        Kb {
            root,
            store,
            kb,
            main,
            repo,
        }
    }

    fn proposer(&self) -> LocalPrincipal {
        let guard = self
            .store
            .lock_write(std::slice::from_ref(&self.kb))
            .expect("lock");
        self.store
            .register_principal(
                &guard,
                PrincipalKind::Test,
                &self.kb,
                &[Permission::Read, Permission::Propose],
            )
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

    fn journal_len(&self) -> usize {
        self.store.intents(&self.kb).expect("intents").len()
    }

    /// Owner edit-mode creates (seeding main).
    fn seed(&mut self, files: &[(String, String)]) {
        if files.is_empty() {
            return;
        }
        let changes: Vec<Value> = files
            .iter()
            .map(|(path, markdown)| {
                json!({ "op": "create", "path": path, "content": { "markdown": markdown } })
            })
            .collect();
        let body = json!({
            "kbId": self.kb.as_str(),
            "baseRevision": self.head().as_str(),
            "idempotencyKey": format!("seed-key-{:08}", self.journal_len()),
            "mode": "edit",
            "title": "Seed",
            "changes": changes,
            "sourceSessionIds": [],
        });
        let typed: ChangesApplyInput = serde_json::from_value(body).expect("typed");
        let result = self
            .store
            .changes_apply(&self.store.owner(), typed)
            .expect("seed");
        assert_eq!(result.kind, ApplyKind::Applied);
        self.main = result.commit_sha;
    }

    fn dream_body(&self, base: &Sha, key: &str, sessions: &Value, dream: &Value) -> Value {
        json!({
            "kbId": self.kb.as_str(),
            "baseRevision": base.as_str(),
            "idempotencyKey": key,
            "mode": "dream",
            "title": "Dream",
            "changes": [],
            "sourceSessionIds": sessions,
            "dream": dream,
        })
    }

    /// A dream call through the typed input (NOT schema-checked by the
    /// caller: the store must enforce the kb/1 schema itself).
    fn dream_raw(&self, who: &LocalPrincipal, body: Value) -> Result<ApplyResult, Failure> {
        let typed: ChangesApplyInput =
            serde_json::from_value(body).map_err(|_| Failure::Boundary)?;
        let result = self.store.changes_apply(who, typed).map_err(Failure::Store);
        if let Ok(result) = &result {
            wire::<ChangesApply>(result);
        }
        result
    }

    fn dream(
        &self,
        who: &LocalPrincipal,
        base: &Sha,
        key: &str,
        sessions: &Value,
        dream: &Value,
    ) -> Result<ApplyResult, Failure> {
        self.dream_raw(who, self.dream_body(base, key, sessions, dream))
    }

    fn get(&self, rev: &Sha, path: &str) -> String {
        self.store
            .documents_get(
                &self.store.owner(),
                kb_client::decode_input::<DocumentsGet>(json!({
                    "kbId": self.kb.as_str(),
                    "rev": rev.as_str(),
                    "path": path,
                }))
                .expect("input"),
            )
            .expect("document")
            .markdown
    }
}

/// Everything a rejected dream must leave untouched.
fn effects(kb: &Kb) -> (String, usize, i64, Option<String>, Option<String>) {
    (
        refs(&kb.repo),
        kb.journal_len(),
        kb.epoch(),
        kb.store
            .proposal(&kb.kb, 1)
            .expect("proposal")
            .map(|pr| pr.head_sha.as_str().to_owned()),
        kb.store
            .proposal(&kb.kb, 2)
            .expect("proposal")
            .map(|pr| pr.head_sha.as_str().to_owned()),
    )
}

fn upsert(id: &str, body: &str) -> Value {
    json!({
        "id": id, "type": "concept", "title": "T", "body": body,
        "citations": [], "provenance": "dream",
    })
}

fn dream_of(upserts: Vec<Value>) -> Value {
    json!({
        "model": { "provider": "fixture-provider", "model": "fixture-model" },
        "redactionApplied": true,
        "upserts": upserts,
    })
}

fn human_doc(id: &str) -> String {
    format!(
        "---\nid: \"{id}\"\ntype: \"concept\"\ntitle: \"Human\"\nprovenance: human\n---\nHuman text.\n"
    )
}

/// Every object of the repository, decompressed, as one lossy string.
fn all_object_bytes(repo: &Path) -> String {
    let out = Command::new("git")
        .current_dir(repo)
        .arg("--git-dir")
        .arg(".")
        .args(["cat-file", "--batch-all-objects", "--batch", "--unordered"])
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .stdin(Stdio::null())
        .output()
        .expect("git");
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// `state.sqlite` plus its WAL/SHM, raw bytes.
fn state_bytes(root: &Path) -> String {
    let mut all = Vec::new();
    for name in ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm"] {
        if let Ok(bytes) = std::fs::read(root.join(name)) {
            all.extend(bytes);
        }
    }
    String::from_utf8_lossy(&all).into_owned()
}

// ── Golden corpus: serialization and digests ───────────────────────────────

#[test]
fn golden_markdown_bytes_match_typescript() {
    let corpus = golden();
    let entries = corpus["serialization"].as_array().expect("serialization");
    assert!(entries.len() >= 6);
    for entry in entries {
        let name = entry["name"].as_str().expect("name");
        let upsert: DreamUpsert = serde_json::from_value(entry["upsert"].clone()).expect("upsert");
        let markdown = dream::serialize_dream_markdown(&upsert);
        assert_eq!(
            markdown,
            entry["markdown"].as_str().expect("markdown"),
            "{name}: byte-identical to serializeDreamMarkdown"
        );
        // The serialized document reads back as the same concept.
        let parsed = kb_local::markdown::parse_markdown(markdown.as_bytes()).expect(name);
        assert_eq!(parsed.document_id.as_deref(), Some(upsert.id.as_str()));
    }
}

#[test]
fn golden_digests_and_commit_trailers_match_typescript() {
    let corpus = golden();
    for entry in corpus["digests"].as_array().expect("digests") {
        let name = entry["name"].as_str().expect("name");
        let metadata: DreamMetadata = serde_json::from_value(entry["dream"].clone()).expect(name);
        let sessions: Vec<Uuid> =
            serde_json::from_value(entry["sourceSessionIds"].clone()).expect(name);
        assert_eq!(
            dream::operation_digest(&metadata, &sessions),
            entry["opDigest"].as_str().expect("op"),
            "{name}"
        );
        assert_eq!(
            dream::source_digest(&sessions),
            entry["sourceDigest"].as_str().expect("source"),
            "{name}"
        );
        let message = dream::format_dream_commit_message(
            entry["title"].as_str().expect("title"),
            &sessions,
            &metadata,
        );
        assert_eq!(message, entry["commitMessage"].as_str().expect("message"));
        for session in &sessions {
            assert!(
                !message.contains(session.as_str()),
                "{name}: trailers carry digests, never raw source session ids"
            );
        }
    }
}

// ── Golden corpus: whole publications ──────────────────────────────────────

#[test]
fn golden_scenarios_publish_identical_paths_bytes_and_result_kinds() {
    let corpus = golden();
    let scenarios = corpus["scenarios"].as_array().expect("scenarios");
    assert!(scenarios.len() >= 15);
    for (i, scenario) in scenarios.iter().enumerate() {
        let name = scenario["name"].as_str().expect("name");
        let mut kb = new_kb(&format!("golden{i}"));
        let seed: Vec<(String, String)> = scenario["seed"]
            .as_array()
            .expect("seed")
            .iter()
            .map(|f| {
                (
                    f["path"].as_str().expect("path").to_owned(),
                    f["markdown"].as_str().expect("markdown").to_owned(),
                )
            })
            .collect();
        kb.seed(&seed);
        let who = if scenario["permission"] == "write" {
            kb.store.owner()
        } else {
            kb.proposer()
        };
        let base = kb.head();
        let before = effects(&kb);
        let outcome = kb.dream(
            &who,
            &base,
            "golden-dream-key-0001",
            &scenario["sourceSessionIds"],
            &scenario["dream"],
        );
        let expect = &scenario["expect"];
        if let Some(code) = expect.get("error").and_then(Value::as_str) {
            let failure = outcome.expect_err(name);
            assert_eq!(failure.code().as_str(), code, "{name}: {failure:?}");
            assert_eq!(
                effects(&kb),
                before,
                "{name}: rejected dream publishes nothing"
            );
            continue;
        }
        let result = outcome.unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert_eq!(
            serde_json::to_value(result.kind).expect("kind"),
            expect["kind"],
            "{name}"
        );
        let paths: Vec<&str> = result.changed_paths.iter().map(|p| p.as_str()).collect();
        assert_eq!(json!(paths), expect["changedPaths"], "{name}");
        assert_eq!(
            json!(result.source_session_ids),
            scenario["sourceSessionIds"],
            "{name}: receipt keeps the source sessions"
        );
        // A main publication always schedules a (lexical) generation.
        assert_eq!(
            result.index_job_id,
            (result.kind == ApplyKind::Applied).then(|| result.operation_id.clone()),
            "{name}"
        );
        assert_eq!(result.base_revision, base);
        match result.kind {
            ApplyKind::Noop => {
                assert_eq!(result.commit_sha, base, "{name}: noop = unchanged target");
                assert_eq!(refs(&kb.repo), before.0, "{name}: no ref moved");
                assert_eq!(kb.epoch(), before.2, "{name}: no index intent");
                assert_eq!(kb.store.proposal(&kb.kb, 1).expect("pr"), None);
            }
            ApplyKind::Applied => {
                assert_eq!(kb.head(), result.commit_sha);
                assert_eq!(result.proposal, None);
            }
            ApplyKind::Proposed => {
                assert_eq!(kb.head(), base, "{name}: main unchanged");
                let pr = result.proposal.as_ref().expect("proposal");
                assert_eq!(pr.head_sha, result.commit_sha);
            }
        }
        for file in expect["files"].as_array().expect("files") {
            let path = file["path"].as_str().expect("path");
            assert_eq!(
                kb.get(&result.commit_sha, path),
                file["markdown"].as_str().expect("markdown"),
                "{name}: {path} bytes identical to TS"
            );
        }
        if result.kind != ApplyKind::Noop {
            assert_eq!(
                git(
                    &kb.repo,
                    &["rev-list", "--count", result.commit_sha.as_str()]
                ),
                (git(&kb.repo, &["rev-list", "--count", base.as_str()])
                    .parse::<usize>()
                    .expect("count")
                    + 1)
                .to_string(),
                "{name}: exactly one commit"
            );
        }
    }
}

#[test]
fn same_input_and_base_yield_the_identical_tree() {
    let corpus = golden();
    let fixture = &corpus["scenarios"][0]["dream"];
    let mut trees = Vec::new();
    for tag in ["treea", "treeb"] {
        let kb = new_kb(tag);
        let result = kb
            .dream(
                &kb.store.owner(),
                &kb.main,
                "same-tree-dream-001",
                &json!([S1]),
                fixture,
            )
            .expect("dream");
        trees.push(git(
            &kb.repo,
            &["rev-parse", &format!("{}^{{tree}}", result.commit_sha)],
        ));
        // Both KBs start from the same deterministic initial tree.
        trees.push(git(
            &kb.repo,
            &["rev-parse", &format!("{}^{{tree}}", kb.main)],
        ));
    }
    assert_eq!(
        trees[0], trees[2],
        "same dream + same base tree => same tree"
    );
    assert_eq!(trees[1], trees[3]);
}

#[test]
fn dream_commit_carries_digest_trailers_only() {
    let corpus = golden();
    let entry = &corpus["digests"][0];
    let kb = new_kb("trailers");
    let result = kb
        .dream(
            &kb.store.owner(),
            &kb.main,
            "trailer-dream-key-01",
            &entry["sourceSessionIds"],
            &entry["dream"],
        )
        .expect("dream");
    let message = git(
        &kb.repo,
        &["log", "-1", "--format=%B", result.commit_sha.as_str()],
    );
    let op = entry["opDigest"].as_str().expect("op");
    let source = entry["sourceDigest"].as_str().expect("source");
    assert!(
        message.contains(&format!("Kb-Op-Digest: {op}")),
        "{message}"
    );
    assert!(
        message.contains(&format!("Kb-Source-Digest: {source}")),
        "{message}"
    );
    for session in entry["sourceSessionIds"].as_array().expect("sessions") {
        assert!(!message.contains(session.as_str().expect("id")));
    }
    assert!(
        !message.contains("fixture-model"),
        "no raw model/private text"
    );
    assert!(!message.contains("Deterministic dream body"));
}

// ── Rejections publish nothing ─────────────────────────────────────────────

#[test]
fn rejected_dreams_publish_nothing_for_owner_and_proposer() {
    let mut kb = new_kb("reject");
    kb.seed(&[
        ("notes/locked.md".into(), human_doc("locked")),
        (
            "notes/legacy.md".into(),
            "---\nid: legacy\n---\nNo provenance.\n".into(),
        ),
    ]);
    let owner = kb.store.owner();
    let proposer = kb.proposer();
    let seven: Vec<Value> = (1..=7)
        .map(|i| upsert(&format!("ok-{i}"), "fine\n"))
        .collect();
    let with = |last: Value| {
        let mut all = seven.clone();
        all.push(last);
        dream_of(all)
    };
    let cases: Vec<(&str, Value, Value, ErrorCode)> = vec![
        (
            "human",
            with(upsert("locked", "x\n")),
            json!([S1]),
            ErrorCode::Forbidden,
        ),
        (
            "absent",
            with(upsert("legacy", "x\n")),
            json!([S1]),
            ErrorCode::Forbidden,
        ),
        (
            "dup-id",
            with(upsert("ok-1", "x\n")),
            json!([S1]),
            ErrorCode::InvalidArgument,
        ),
        (
            "secret",
            with(upsert("leak", &format!("token {SECRET}\n"))),
            json!([S1]),
            ErrorCode::InvalidArgument,
        ),
        (
            "oversized",
            with(upsert("big", &"a".repeat(64 * 1024 + 1))),
            json!([S1]),
            ErrorCode::InvalidArgument,
        ),
        (
            "no-sources",
            with(upsert("x", "x\n")),
            json!([]),
            ErrorCode::InvalidArgument,
        ),
        (
            "dup-sources",
            with(upsert("x", "x\n")),
            json!([S1, S1]),
            ErrorCode::InvalidArgument,
        ),
        (
            "ninth",
            {
                let mut nine = seven.clone();
                nine.push(upsert("ok-8", "x\n"));
                nine.push(upsert("ok-9", "x\n"));
                dream_of(nine)
            },
            json!([S1]),
            ErrorCode::InvalidArgument,
        ),
    ];
    for (name, dream, sessions, code) in cases {
        for who in [&owner, &proposer] {
            let before = effects(&kb);
            let key = format!("reject-{name}-{}", who.id().len());
            let key = format!("{key:0<16}");
            let failure = kb
                .dream(who, &kb.main, &key, &sessions, &dream)
                .expect_err(name);
            assert_eq!(failure.code(), code, "{name}: {failure:?}");
            assert_eq!(effects(&kb), before, "{name}: zero effects");
        }
    }
    // Generic changes in dream mode, and dream metadata missing.
    let mut body = kb.dream_body(
        &kb.main,
        "generic-changes-001",
        &json!([S1]),
        &dream_of(vec![]),
    );
    body["changes"] = json!([{ "op": "delete", "path": "notes/locked.md" }]);
    assert_eq!(
        kb.dream_raw(&owner, body).expect_err("changes").code(),
        ErrorCode::InvalidArgument
    );
    let mut body = kb.dream_body(&kb.main, "missing-dream-0001", &json!([S1]), &Value::Null);
    body.as_object_mut().expect("object").remove("dream");
    assert_eq!(
        kb.dream_raw(&owner, body).expect_err("no dream").code(),
        ErrorCode::InvalidArgument
    );
    // After all that, a valid dream still publishes (keys were not burned).
    let reused = format!("{:0<16}", format!("reject-human-{}", owner.id().len()));
    let ok = kb
        .dream(
            &owner,
            &kb.main,
            &reused,
            &json!([S1]),
            &dream_of(vec![upsert("fresh", "ok\n")]),
        )
        .expect("valid dream after rejections");
    assert_eq!(ok.kind, ApplyKind::Applied);
    // The human documents are untouched.
    assert_eq!(
        kb.get(&ok.commit_sha, "notes/locked.md"),
        human_doc("locked")
    );
}

#[test]
fn secrets_never_reach_errors_journal_or_objects() {
    let kb = new_kb("secret");
    let owner = kb.store.owner();
    let mut ups: Vec<Value> = (1..=7).map(|i| upsert(&format!("s{i}"), "ok\n")).collect();
    ups.push(json!({
        "id": "s8", "type": "concept", "title": "Bearer\tsynthetic-review-token-0123456789",
        "body": format!("leaked {SECRET} here\n"),
        "citations": [{ "label": "auth", "target": "Authorization: Bearer synthetic-token-0123456789" }],
        "provenance": "dream",
    }));
    let failure = kb
        .dream(
            &owner,
            &kb.main,
            "secret-dream-key-01",
            &json!([S1]),
            &dream_of(ups),
        )
        .expect_err("secret");
    assert_eq!(failure.code(), ErrorCode::InvalidArgument);
    let rendered = format!("{failure:?} {:?}", failure.code());
    for needle in [
        SECRET,
        "synthetic-review-token",
        "synthetic-token-0123456789",
    ] {
        assert!(!rendered.contains(needle), "error must not echo {needle}");
        assert!(
            !state_bytes(&kb.root).contains(needle),
            "journal/state must not hold {needle}"
        );
        assert!(
            !all_object_bytes(&kb.repo).contains(needle),
            "no object holds {needle}"
        );
    }
    // Title and model metadata are scanned too.
    let mut body = kb.dream_body(
        &kb.main,
        "secret-title-key-01",
        &json!([S1]),
        &dream_of(vec![upsert("a", "b\n")]),
    );
    body["title"] = json!(format!("Dream {SECRET}"));
    let failure = kb.dream_raw(&owner, body).expect_err("title");
    assert_eq!(failure.code(), ErrorCode::InvalidArgument);
    assert!(!format!("{failure:?}").contains(SECRET));
    assert_eq!(kb.journal_len(), 1, "only the create receipt");
}

#[test]
fn sealed_references_stay_symbolic_and_are_rejected() {
    let kb = new_kb("sealed");
    let reference = "{{sealed:v1:knowledge_base:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222}}";
    let before = effects(&kb);
    for (field, value) in [
        ("body", format!("value {reference}\n")),
        ("title", reference.to_owned()),
    ] {
        let mut up = upsert("sealed-note", "b\n");
        up[field] = json!(value);
        let failure = kb
            .dream(
                &kb.store.owner(),
                &kb.main,
                &format!("sealed-{field:0<12}"),
                &json!([S1]),
                &dream_of(vec![up]),
            )
            .expect_err(field);
        assert_eq!(failure.code(), ErrorCode::InvalidArgument, "{field}");
        assert_eq!(effects(&kb), before);
    }
}

// ── Noop receipts ──────────────────────────────────────────────────────────

#[test]
fn noop_dream_preserves_metadata_without_job_or_commit() {
    let kb = new_kb("noop");
    let owner = kb.store.owner();
    let before = effects(&kb);
    let empty = dream_of(vec![]);
    let result = kb
        .dream(
            &owner,
            &kb.main,
            "noop-dream-key-0001",
            &json!([S1]),
            &empty,
        )
        .expect("noop");
    assert_eq!(result.kind, ApplyKind::Noop);
    assert_eq!(result.commit_sha, kb.main);
    assert_eq!(result.proposal, None);
    assert_eq!(result.index_job_id, None);
    assert!(result.changed_paths.is_empty());
    assert_eq!(json!(result.source_session_ids), json!([S1]));
    assert_eq!(refs(&kb.repo), before.0, "no commit, no ref");
    assert_eq!(kb.epoch(), before.2, "no index intent");
    assert_eq!(
        kb.journal_len(),
        before.1 + 1,
        "exactly one durable receipt"
    );
    // The receipt keeps the informational model and source metadata.
    let receipt = kb
        .store
        .dream_receipt(&kb.kb, &result.operation_id)
        .expect("receipt")
        .expect("dream metadata");
    assert_eq!(receipt["model"]["model"], "fixture-model");
    assert_eq!(receipt["sourceSessionIds"], json!([S1]));
    assert_eq!(
        receipt["opDigest"],
        json!(dream::operation_digest(
            &serde_json::from_value(empty.clone()).expect("typed"),
            &[Uuid::parse(S1).expect("uuid")]
        ))
    );
    // Replay returns the same receipt; a different request is a mismatch.
    let again = kb
        .dream(
            &owner,
            &kb.main,
            "noop-dream-key-0001",
            &json!([S1]),
            &empty,
        )
        .expect("replay");
    assert_eq!(again, result);
    let other = kb
        .dream(
            &owner,
            &kb.main,
            "noop-dream-key-0001",
            &json!(["00000000-0000-4000-8000-000000000002"]),
            &empty,
        )
        .expect_err("mismatch");
    assert_eq!(other.code(), ErrorCode::IdempotencyMismatch);
    // A propose-only noop opens no proposal and burns no number.
    let proposer = kb.proposer();
    let noop = kb
        .dream(
            &proposer,
            &kb.main,
            "noop-dream-key-0002",
            &json!([]),
            &empty,
        )
        .expect("proposer noop");
    assert_eq!(noop.kind, ApplyKind::Noop);
    assert_eq!(noop.proposal, None);
    let real = kb
        .dream(
            &proposer,
            &kb.main,
            "real-dream-key-0003",
            &json!([S1]),
            &dream_of(vec![upsert("n", "b\n")]),
        )
        .expect("proposal");
    assert_eq!(
        real.proposal.expect("pr").number,
        1,
        "noop burned no number"
    );
}

// ── Proposed dreams: persisted guard input and the merge guard ──────────────

#[test]
fn proposed_dream_metadata_survives_restart_and_guard_conflicts_on_human_main() {
    let mut kb = new_kb("guard");
    kb.seed(&[(
        "notes/kept.md".into(),
        "---\nid: \"kept\"\ntype: \"concept\"\ntitle: \"Old\"\nprovenance: dream\n---\nOld.\n"
            .into(),
    )]);
    let proposer = kb.proposer();
    let result = kb
        .dream(
            &proposer,
            &kb.main,
            "guard-dream-key-0001",
            &json!([S1]),
            &dream_of(vec![upsert("kept", "Kept.\n"), upsert("fresh", "Fresh.\n")]),
        )
        .expect("proposed");
    assert_eq!(result.kind, ApplyKind::Proposed);
    let number = result.proposal.as_ref().expect("pr").number;
    assert_eq!(kb.head(), kb.main, "main unchanged");

    // Restart: the persisted guard input survives.
    let kb = kb.reopen();
    let persisted = kb
        .store
        .proposal_dream_metadata(&kb.kb, number)
        .expect("read")
        .expect("dream metadata persisted with the proposal");
    assert_eq!(persisted["upserts"].as_array().expect("upserts").len(), 2);
    assert_eq!(persisted["model"]["provider"], "fixture-provider");
    assert_eq!(
        persisted["guardTouchedPaths"]["kept"],
        json!([{ "path": "notes/kept.md", "existedAtBase": true }])
    );
    assert_eq!(
        persisted["guardTouchedPaths"]["fresh"],
        json!([{ "path": "concepts/fresh.md", "existedAtBase": false }])
    );
    kb.store
        .dream_merge_guard(&kb.kb, number)
        .expect("unchanged main passes the guard");

    // A preserved dream path may be updated on main (still provenance dream).
    let owner = kb.store.owner();
    let body = json!({
        "kbId": kb.kb.as_str(), "baseRevision": kb.head().as_str(),
        "idempotencyKey": "main-dream-update-01", "mode": "edit", "title": "Tweak",
        "changes": [{ "op": "replace", "path": "notes/kept.md", "content": { "markdown":
            "---\nid: \"kept\"\ntype: \"concept\"\ntitle: \"Tweaked\"\nprovenance: dream\n---\nTweaked.\n" } }],
        "sourceSessionIds": [],
    });
    kb.store
        .changes_apply(&owner, serde_json::from_value(body).expect("typed"))
        .expect("tweak");
    kb.store
        .dream_merge_guard(&kb.kb, number)
        .expect("dream-provenance main edit still passes");

    // A later human edit on main at a dream-touched path conflicts.
    let body = json!({
        "kbId": kb.kb.as_str(), "baseRevision": kb.head().as_str(),
        "idempotencyKey": "main-human-create-01", "mode": "edit", "title": "Human",
        "changes": [{ "op": "create", "path": "concepts/fresh.md", "content": { "markdown": human_doc("fresh") } }],
        "sourceSessionIds": [],
    });
    kb.store
        .changes_apply(&owner, serde_json::from_value(body).expect("typed"))
        .expect("human edit");
    let kb = kb.reopen();
    let conflict = kb
        .store
        .dream_merge_guard(&kb.kb, number)
        .expect_err("human provenance on main conflicts");
    assert_eq!(conflict.protocol_code(), ErrorCode::Conflict);
    // The proposal itself is untouched by the guard evaluation.
    assert_eq!(
        kb.store
            .proposal(&kb.kb, number)
            .expect("pr")
            .expect("pr")
            .head_sha,
        result.commit_sha
    );
}

#[test]
fn guard_conflicts_when_a_base_document_is_deleted_or_turned_human() {
    let mut kb = new_kb("guard2");
    kb.seed(&[(
        "notes/gone.md".into(),
        "---\nid: \"gone\"\ntype: \"concept\"\ntitle: \"Old\"\nprovenance: dream\n---\nOld.\n"
            .into(),
    )]);
    let proposer = kb.proposer();
    let result = kb
        .dream(
            &proposer,
            &kb.main,
            "guard2-dream-key-01",
            &json!([S1]),
            &dream_of(vec![upsert("gone", "New.\n")]),
        )
        .expect("proposed");
    let number = result.proposal.expect("pr").number;
    let owner = kb.store.owner();
    let body = json!({
        "kbId": kb.kb.as_str(), "baseRevision": kb.head().as_str(),
        "idempotencyKey": "main-delete-key-0001", "mode": "edit", "title": "Delete",
        "changes": [{ "op": "delete", "path": "notes/gone.md" }],
        "sourceSessionIds": [],
    });
    kb.store
        .changes_apply(&owner, serde_json::from_value(body).expect("typed"))
        .expect("delete");
    let err = kb
        .store
        .dream_merge_guard(&kb.kb, number)
        .expect_err("deleted");
    assert_eq!(err.protocol_code(), ErrorCode::Conflict);
    // Human takeover of the id at a path the proposal never recorded.
    let body = json!({
        "kbId": kb.kb.as_str(), "baseRevision": kb.head().as_str(),
        "idempotencyKey": "main-takeover-key-01", "mode": "edit", "title": "Takeover",
        "changes": [{ "op": "create", "path": "elsewhere/gone.md", "content": { "markdown": human_doc("gone") } }],
        "sourceSessionIds": [],
    });
    kb.store
        .changes_apply(&owner, serde_json::from_value(body).expect("typed"))
        .expect("takeover");
    let err = kb
        .store
        .dream_merge_guard(&kb.kb, number)
        .expect_err("takeover");
    assert_eq!(err.protocol_code(), ErrorCode::Conflict);
    // A proposal without dream metadata has nothing to guard; an unknown one
    // is NOT_FOUND.
    assert_eq!(
        kb.store
            .dream_merge_guard(&kb.kb, 99)
            .expect_err("unknown")
            .protocol_code(),
        ErrorCode::NotFound
    );
}

#[test]
fn second_dream_appends_to_the_same_proposal_cumulatively() {
    let kb = new_kb("append");
    let proposer = kb.proposer();
    let first = kb
        .dream(
            &proposer,
            &kb.main,
            "append-dream-key-01",
            &json!([S1]),
            &dream_of(vec![upsert("a", "A.\n")]),
        )
        .expect("first");
    let pr = first.proposal.expect("pr");
    // The next dream plans against the proposal HEAD (its doc-ID map).
    let mut request = kb.dream_body(
        &pr.head_sha,
        "append-dream-key-02",
        &json!([S1]),
        &dream_of(vec![upsert("a", "A2.\n"), upsert("b", "B.\n")]),
    );
    // Dream writes share overwrite consent with every other content write.
    let refused = kb
        .dream_raw(&proposer, request.clone())
        .expect_err("implicit overwrite");
    assert_eq!(refused.code(), ErrorCode::Conflict);
    request["proposalNumber"] = json!(pr.number);
    request["proposalHeadSha"] = json!(pr.head_sha);
    let second = kb.dream_raw(&proposer, request).expect("second");
    assert_eq!(second.kind, ApplyKind::Proposed);
    let pr2 = second.proposal.expect("pr");
    assert_eq!(pr2.number, pr.number);
    assert_eq!(pr2.version, 2);
    let paths: Vec<&str> = second.changed_paths.iter().map(|p| p.as_str()).collect();
    assert_eq!(
        paths,
        ["concepts/a.md", "concepts/b.md"],
        "a is now a replace"
    );
    let persisted = kb
        .store
        .proposal_dream_metadata(&kb.kb, pr.number)
        .expect("read")
        .expect("metadata");
    let ids: Vec<&str> = persisted["upserts"]
        .as_array()
        .expect("upserts")
        .iter()
        .map(|u| u["id"].as_str().expect("id"))
        .collect();
    assert_eq!(ids, ["a", "b"]);
    assert_eq!(
        persisted["upserts"][0]["body"], "A2.\n",
        "latest upsert wins"
    );
    assert_eq!(
        persisted["guardTouchedPaths"]["a"],
        json!([{ "path": "concepts/a.md", "existedAtBase": false }])
    );
    // An edit-mode change to the same proposal keeps the dream metadata.
    let body = json!({
        "kbId": kb.kb.as_str(), "baseRevision": pr2.head_sha.as_str(),
        "idempotencyKey": "append-edit-key-003", "mode": "edit", "title": "Human note",
        "changes": [{ "op": "create", "path": "notes/h.md", "content": { "markdown": "# h\n" } }],
        "sourceSessionIds": [],
    });
    kb.store
        .changes_apply(&proposer, serde_json::from_value(body).expect("typed"))
        .expect("edit");
    let still = kb
        .store
        .proposal_dream_metadata(&kb.kb, pr.number)
        .expect("read")
        .expect("metadata kept");
    assert_eq!(still, persisted);
}

#[test]
fn crash_after_ref_move_recovers_the_dream_metadata_exactly_once() {
    for defer_startup in [false, true] {
        let kb = new_kb("crash");
        let proposer = kb.proposer();
        let body = kb.dream_body(
            &kb.main,
            "crash-dream-key-0001",
            &json!([S1]),
            &dream_of(vec![upsert("c", "C.\n")]),
        );
        let typed: ChangesApplyInput = serde_json::from_value(body.clone()).expect("typed");
        let mut ref_moved = false;
        let err = kb
            .store
            .changes_apply_observed(&proposer, typed, &mut |stage| {
                if stage == Stage::RefMoved {
                    ref_moved = true;
                    Err(StoreError::StorageUnavailable("injected crash".into()))
                } else {
                    Ok(())
                }
            })
            .expect_err("interrupted after the ref moved");
        assert_eq!(err.protocol_code(), ErrorCode::StorageUnavailable);
        assert!(ref_moved, "the intended fault stage was not reached: {err}");

        // Startup recovery is opportunistic while a writer/descendant holds the
        // store lock. Force that branch as well as ordinary startup; production
        // reads must gate recovery before raw metadata inspection in either case.
        let startup_lock = defer_startup.then(|| {
            let file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(kb.store.paths().store_lock_file())
                .expect("store lock file");
            file.lock().expect("defer startup recovery");
            file
        });
        let kb = kb.reopen();
        if let Some(file) = startup_lock {
            assert_eq!(kb.store.proposal(&kb.kb, 1).expect("raw inspection"), None);
            file.unlock().expect("release startup recovery");
        }
        kb.store.read_kb(&kb.kb).expect("gated read recovers");
        let persisted = kb
            .store
            .proposal_dream_metadata(&kb.kb, 1)
            .expect("read")
            .expect("recovery applied the persisted metadata");
        assert_eq!(persisted["upserts"][0]["id"], "c");
        // Replaying the key returns the recovered receipt; still one PR.
        let replay = kb.dream_raw(&proposer, body).expect("replay");
        assert_eq!(replay.kind, ApplyKind::Proposed);
        assert_eq!(replay.proposal.expect("pr").version, 1);
        assert_eq!(kb.store.proposal(&kb.kb, 2).expect("pr"), None);
    }
}

// ── Detector floor ─────────────────────────────────────────────────────────

#[test]
fn detector_is_a_conservative_floor_not_complete_secret_detection() {
    assert!(!sensitive_text::contains_known_credential_patterns(
        "routine prose without tokens"
    ));
    assert!(!sensitive_text::contains_known_credential_patterns(
        "custom api_key=not-in-floor"
    ));
    assert!(sensitive_text::contains_known_credential_patterns(SECRET));
    // A custom secret format is NOT caught: the floor is documented, and a
    // dream carrying one publishes (redactionApplied is not proof).
    let kb = new_kb("floor");
    let ok = kb
        .dream(
            &kb.store.owner(),
            &kb.main,
            "floor-dream-key-0001",
            &json!([S1]),
            &dream_of(vec![upsert("f", "custom api_key=not-in-floor\n")]),
        )
        .expect("not detected by the floor");
    assert_eq!(ok.kind, ApplyKind::Applied);
}

/// A new id mapping to a path the KB refuses (`con` -> `concepts/con.md`,
/// a Windows-reserved name) says why, at that upsert's id (as the
/// server does), and publishes nothing.
#[test]
fn reserved_dream_path_is_a_typed_refusal_at_the_upsert_id() {
    let kb = new_kb("reserved");
    let owner = kb.store.owner();
    let before = effects(&kb);
    let error = kb
        .dream(
            &owner,
            &kb.main,
            "reserved-dream-key-01",
            &json!([S1]),
            &dream_of(vec![upsert("fine", "x\n"), upsert("con", "x\n")]),
        )
        .expect_err("reserved path");
    let Failure::Store(error) = error else {
        panic!("store refusal expected");
    };
    assert_eq!(error.protocol_code(), ErrorCode::InvalidArgument);
    assert_eq!(
        error.protocol_details(),
        json!({"reason": "RESERVED_PATH", "field": "/dream/upserts/1/id"})
    );
    assert_eq!(effects(&kb), before);
}
