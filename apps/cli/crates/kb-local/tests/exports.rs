//! Spec-first tests: real managed store, Git, CAS and framed I/O.
use base64::{Engine, engine::general_purpose::STANDARD};
use kb_client::{
    ErrorCode, decode_input,
    schema::{Direction, validate},
    snapshot::content_hash,
    types::*,
};
use kb_local::{
    LocalPrincipal, PrincipalKind, Store, StoreError,
    exports::{ExportControl, ExportStage},
    tree::{ManifestEntry, canonical_manifest_bytes},
};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::OpenOptions,
    io::{Seek, SeekFrom, Write},
    process::Command,
    time::Duration,
};
#[path = "support/fixture.rs"]
mod fixture;

fn input<T: Tool>(v: Value) -> T::Input {
    decode_input::<T>(v).expect("input")
}
fn wire<T: Tool>(v: &T::Output) {
    validate(
        T::NAME.as_str(),
        Direction::Output,
        &serde_json::to_value(v).expect("fixture operation"),
    )
    .expect("wire");
}
fn handle(kb: &KbId, id: &Uuid) -> TransferRef {
    TransferRef {
        kb_id: kb.clone(),
        transfer_id: id.clone(),
    }
}
fn frame(kb: &KbId, id: &Uuid, offset: u64, max_bytes: Option<u64>) -> TransferReadInput {
    TransferReadInput {
        kb_id: kb.clone(),
        transfer_id: id.clone(),
        offset,
        max_bytes,
    }
}
#[path = "support/parked_git.rs"]
mod parked_git;
struct Setup {
    s: Store,
    f: fixture::Fixture,
    kb: KbId,
}
impl Setup {
    fn new(tag: &str) -> Self {
        let mut f = fixture::Fixture::new(tag);
        let s = Store::open(&f.root.join("store")).expect("fixture operation");
        let kb = s.bases_create(&s.owner(), input::<BasesCreate>(json!({"name":"Exports", "slug":"exports", "description":"Export fixture knowledge base", "idempotencyKey":"create-exports-000000"}))).expect("fixture operation").kb.id;
        f.repo = s.paths().repo_dir(&kb);
        Self { s, f, kb }
    }
    fn db(&self) -> Connection {
        Connection::open(self.s.paths().state_db()).expect("fixture operation")
    }
    fn head(&self) -> Sha {
        Sha::parse(
            self.s
                .read_kb(&self.kb)
                .expect("fixture operation")
                .head_sha
                .as_deref()
                .expect("fixture operation"),
        )
        .expect("fixture operation")
    }
    fn prepare(
        &self,
        p: &LocalPrincipal,
        kind: &str,
        key: &str,
        rev: Option<&Sha>,
    ) -> Result<ExportPrepareOutput, StoreError> {
        let mut v = json!({"kbId":self.kb,"kind":kind,"idempotencyKey":key});
        if let Some(r) = rev {
            v["rev"] = json!(r);
        }
        let o = self.s.export_prepare(p, input::<ExportPrepare>(v));
        if let Ok(v) = &o {
            wire::<ExportPrepare>(v);
            assert!(
                !serde_json::to_string(v)
                    .expect("fixture operation")
                    .contains("file:")
            );
        }
        o
    }
    fn read(
        &self,
        p: &LocalPrincipal,
        id: &Uuid,
        offset: u64,
        max: Option<u64>,
    ) -> Result<TransferReadOutput, StoreError> {
        let o = self.s.transfer_read(p, frame(&self.kb, id, offset, max));
        if let Ok(v) = &o {
            wire::<TransferRead>(v);
        }
        o
    }
    fn complete(&self, id: &Uuid) {
        let o = self
            .s
            .export_complete(&self.s.owner(), handle(&self.kb, id))
            .expect("fixture operation");
        wire::<ExportComplete>(&o);
    }
    fn principal(&self) -> LocalPrincipal {
        let g = self
            .s
            .lock_write(std::slice::from_ref(&self.kb))
            .expect("fixture operation");
        self.s
            .register_principal(&g, PrincipalKind::Test, &self.kb, &[Permission::Read])
            .expect("fixture operation")
    }
    fn artifact(&self, id: &Uuid) -> std::path::PathBuf {
        self.s
            .paths()
            .assets_dir()
            .join("tmp")
            .join(format!("export-{id}"))
    }
    fn active(&self) -> i64 {
        self.db()
            .query_row(
                "SELECT count(*) FROM export_artifacts WHERE state IN ('WRITING','READY')",
                [],
                |r| r.get(0),
            )
            .expect("fixture operation")
    }
    // Authoritative fixture setup, independent of the export API. Real CAS
    // publication and retained catalog/lineage; raw Git also exercises hostile names.
    fn snapshot(&self, paths: &[String], bytes: &[u8], extra: &[(&str, &[u8])]) -> Sha {
        let hash = content_hash(bytes);
        if !paths.is_empty() {
            kb_local::cas::publish_cas(
                self.s.paths(),
                bytes,
                &hash,
                bytes.len() as u64,
                Mime::ApplicationPdf,
            )
            .expect("fixture operation");
            self.db().execute("INSERT INTO asset_blobs(hash,size,mime,verified_at) VALUES (?1,?2,'application/pdf','fixture') ON CONFLICT DO NOTHING",(hash.as_str(),bytes.len() as i64)).expect("fixture operation");
            self.db().execute("INSERT INTO kb_asset_lineage(kb_id,hash,actor_key,source) VALUES (?1,?2,'fixture','UPLOAD') ON CONFLICT DO NOTHING",(self.kb.as_str(),hash.as_str())).expect("fixture operation");
        }
        let entries: Vec<_> = paths
            .iter()
            .map(|p| ManifestEntry {
                path: p.clone(),
                hash: hash.as_str().into(),
                size: bytes.len() as u64,
                mime: "application/pdf".into(),
            })
            .collect();
        let manifest = canonical_manifest_bytes(&entries);
        let head = self.head();
        let mut files = fixture::with_required(extra);
        files.retain(|(p, _)| *p != ".assets/manifest.json");
        files.push((".assets/manifest.json", &manifest));
        let rev = self.f.commit_files(&files, &[head.as_str()]);
        self.db()
            .execute(
                "UPDATE kbs SET head_sha=?2 WHERE id=?1",
                (self.kb.as_str(), &rev),
            )
            .expect("fixture operation");
        Sha::parse(&rev).expect("fixture operation")
    }
}
fn pdf(size: usize) -> Vec<u8> {
    let mut b = b"%PDF-1.4\n/Catalog /Pages /Page /MediaBox /Root endobj\nxref\n".to_vec();
    let x = b
        .windows(4)
        .position(|w| w == b"xref")
        .expect("fixture operation");
    let end = format!("\nstartxref\n{x}\n%%EOF\n");
    b.resize(size.max(b.len() + end.len()) - end.len(), b' ');
    b.extend_from_slice(end.as_bytes());
    b
}
fn code<T: std::fmt::Debug>(o: Result<T, StoreError>, c: ErrorCode) {
    assert_eq!(o.expect_err("expected rejection").protocol_code(), c);
}
fn u16at(b: &[u8], n: usize) -> usize {
    u16::from_le_bytes(b[n..n + 2].try_into().expect("fixture operation")) as usize
}
fn u32at(b: &[u8], n: usize) -> usize {
    u32::from_le_bytes(b[n..n + 4].try_into().expect("fixture operation")) as usize
}
// Independent central-directory parser checks exact entries, local headers,
// STORE method, CRCs (bitwise reference), payload lengths and offsets.
fn zip_entries(bytes: &[u8]) -> BTreeMap<String, Vec<u8>> {
    let end = bytes.len() - 22;
    assert_eq!(u32at(bytes, end), 0x06054b50);
    let mut at = u32at(bytes, end + 16);
    let mut out = BTreeMap::new();
    for _ in 0..u16at(bytes, end + 10) {
        assert_eq!(u32at(bytes, at), 0x02014b50);
        assert_eq!(u16at(bytes, at + 10), 0);
        let n = u16at(bytes, at + 28);
        let name =
            String::from_utf8(bytes[at + 46..at + 46 + n].to_vec()).expect("fixture operation");
        let local = u32at(bytes, at + 42);
        assert_eq!(u32at(bytes, local), 0x04034b50);
        assert_eq!(&bytes[local + 30..local + 30 + n], name.as_bytes());
        let start = local + 30 + n;
        let size = u32at(bytes, at + 24);
        let data = bytes[start..start + size].to_vec();
        let table: Vec<_> = (0..256u32)
            .map(|mut c| {
                for _ in 0..8 {
                    c = (c >> 1) ^ if c & 1 == 1 { 0xedb88320 } else { 0 };
                }
                c
            })
            .collect();
        let crc = data.iter().fold(!0u32, |crc, b| {
            (crc >> 8) ^ table[((crc ^ u32::from(*b)) & 255) as usize]
        });
        assert_eq!((!crc) as usize, u32at(bytes, at + 16));
        assert!(out.insert(name, data).is_none());
        at += 46 + n;
    }
    assert_eq!(at, end);
    out
}
fn reconstruct(t: &Setup, p: &LocalPrincipal, o: &ExportPrepareOutput) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut at = 0;
    loop {
        let f = t
            .read(p, &o.transfer_id, at, None)
            .expect("fixture operation");
        assert_eq!(f.offset, at);
        assert_eq!(f.content_hash, o.content_hash);
        let b = STANDARD.decode(&f.bytes_base64).expect("fixture operation");
        assert_eq!(STANDARD.encode(&b), f.bytes_base64);
        assert!(!b.is_empty() && b.len() <= 196608);
        at += b.len() as u64;
        assert_eq!(f.next_offset, at);
        bytes.extend_from_slice(&b);
        if f.eof {
            break;
        }
    }
    assert_eq!(at, o.size);
    assert_eq!(content_hash(&bytes), o.content_hash);
    bytes
}
#[test]
fn empty_default_whole_and_asset_zip_are_exact() {
    let t = Setup::new("empty");
    let p = t.s.owner();
    let a = t
        .prepare(&p, "assets", "empty-assets-000000", None)
        .expect("fixture operation");
    assert!(zip_entries(&reconstruct(&t, &p, &a)).is_empty());
    t.complete(&a.transfer_id);
    let o = t
        .prepare(&p, "whole", "empty-whole-0000000", None)
        .expect("fixture operation");
    let z = zip_entries(&reconstruct(&t, &p, &o));
    assert_eq!(z.len(), 3);
    assert_eq!(z[".gitignore"], fixture::GITIGNORE);
    assert_eq!(z[".assets/manifest.json"], fixture::MANIFEST);
    let d =
        t.s.documents_get(
            &p,
            input::<DocumentsGet>(json!({"kbId":t.kb,"path":"index.md"})),
        )
        .expect("fixture operation");
    assert_eq!(z["index.md"], d.markdown.as_bytes());
}
#[test]
fn two_hundred_mib_fixture_reconstructs_exact_entries_and_hash() {
    let t = Setup::new("200mib");
    // This case measures byte integrity, not elapsed-time expiry. Keep the
    // 15-minute product TTL independent of slow reconstruction on shared hosts.
    // A future epoch also keeps the real background sweep out of this fixture;
    // every_frame_and_receipt_rechecks_actor_kb_live_read_and_expiry covers TTL.
    t.s.set_cursor_clock_for_tests(4_102_444_800);
    let payload = pdf(25 * 1024 * 1024);
    let paths: Vec<_> = (0..8).map(|i| format!("media/part-{i}.pdf")).collect();
    let rev = t.snapshot(&paths, &payload, &[]);
    // This fixture checks full-volume reconstruction. Disk throughput must not
    // consume the transfer TTL; the authority test checks its exact expiry.
    t.s.advance_clock_for_tests(0);
    let o = t
        .prepare(&t.s.owner(), "whole", "large-export-00000", Some(&rev))
        .expect("fixture operation");
    let bytes = reconstruct(&t, &t.s.owner(), &o);
    let z = zip_entries(&bytes);
    assert_eq!(z.len(), 11);
    for p in paths {
        assert_eq!(z[&p], payload);
    }
    assert_eq!(o.rev, rev);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(t.artifact(&o.transfer_id))
                .expect("fixture operation")
                .permissions()
                .mode()
                & 0o077,
            0
        );
    }
    t.complete(&o.transfer_id);
    assert!(!t.artifact(&o.transfer_id).exists());
    assert_eq!(t.active(), 0);
    assert!(kb_local::cas::blob_path(t.s.paths(), &content_hash(&payload)).exists());
}
#[test]
fn preflight_limits_slip_casefold_and_file_directory_collisions_create_no_artifact() {
    for (tag, paths, extra, size, expected) in [
        (
            "oversize",
            (0..11).map(|i| format!("{i}.pdf")).collect(),
            vec![],
            25 * 1024 * 1024,
            ErrorCode::QuotaExceeded,
        ),
        (
            "slip",
            vec!["../escape.pdf".into()],
            vec![],
            128,
            ErrorCode::InvalidArgument,
        ),
        (
            "case",
            vec!["A.pdf".into(), "a.pdf".into()],
            vec![],
            128,
            ErrorCode::InvalidArgument,
        ),
        (
            "prefix",
            vec!["dir.pdf".into(), "dir.pdf/x.pdf".into()],
            vec![],
            128,
            ErrorCode::InvalidArgument,
        ),
        (
            "tree-collision",
            vec!["index.md".into()],
            vec![],
            128,
            ErrorCode::InvalidArgument,
        ),
        (
            "tree-case",
            vec![],
            vec![("INDEX.md", b"other".as_slice())],
            128,
            ErrorCode::InvalidArgument,
        ),
        (
            "entries",
            (0..8192).map(|i| format!("assets/{i:05}.pdf")).collect(),
            vec![],
            128,
            ErrorCode::QuotaExceeded,
        ),
    ] {
        let t = Setup::new(tag);
        t.snapshot(&paths, &pdf(size), &extra);
        code(
            t.prepare(&t.s.owner(), "whole", "invalid-export-000", None),
            expected,
        );
        assert_eq!(t.active(), 0);
        assert_eq!(
            t.db()
                .query_row("SELECT count(*) FROM export_artifacts", [], |r| r
                    .get::<_, i64>(0))
                .expect("fixture operation"),
            0
        );
        assert_eq!(
            std::fs::read_dir(t.s.paths().assets_dir().join("tmp"))
                .expect("fixture operation")
                .count(),
            0
        );
    }
}
#[test]
fn old_revision_replay_is_pinned_and_foreign_or_unreachable_commit_denied() {
    let t = Setup::new("history");
    let payload = pdf(128);
    let old = t.snapshot(
        &["old.pdf".into()],
        &payload,
        &[("index.md", b"old markdown")],
    );
    let a = t
        .prepare(&t.s.owner(), "whole", "historical-export-0", Some(&old))
        .expect("fixture operation");
    let next = t.snapshot(&[], &payload, &[("index.md", b"new markdown")]);
    assert_ne!(old, next);
    let again = t
        .prepare(&t.s.owner(), "whole", "historical-export-0", Some(&old))
        .expect("fixture operation");
    assert_eq!(
        serde_json::to_value(&a).expect("fixture operation"),
        serde_json::to_value(&again).expect("fixture operation")
    );
    let z = zip_entries(&reconstruct(&t, &t.s.owner(), &a));
    assert_eq!(z["index.md"], b"old markdown");
    assert_eq!(z["old.pdf"], payload);
    code(
        t.prepare(&t.s.owner(), "assets", "historical-export-0", Some(&old)),
        ErrorCode::IdempotencyMismatch,
    );
    t.complete(&a.transfer_id);
    let tree = t.f.tree(&fixture::with_required(&[]));
    let orphan = Sha::parse(&t.f.commit(&tree, &[])).expect("fixture operation");
    code(
        t.prepare(&t.s.owner(), "whole", "orphan-export-00000", Some(&orphan)),
        ErrorCode::NotFound,
    );
    let foreign = fixture::Fixture::new("foreign");
    let sha = Sha::parse(&foreign.commit_files(&[("foreign.md", b"foreign")], &[]))
        .expect("fixture operation");
    code(
        t.prepare(&t.s.owner(), "whole", "foreign-export-000", Some(&sha)),
        ErrorCode::NotFound,
    );
}
#[test]
fn every_frame_and_receipt_rechecks_actor_kb_live_read_and_expiry() {
    let t = Setup::new("authority");
    let p = t.principal();
    let thief = t.principal();
    t.s.advance_clock_for_tests(0);
    let o = t
        .prepare(&p, "whole", "reader-export-0000", None)
        .expect("fixture operation");
    t.read(&p, &o.transfer_id, 0, Some(1))
        .expect("fixture operation");
    code(t.read(&thief, &o.transfer_id, 0, None), ErrorCode::NotFound);
    code(
        t.s.export_complete(&thief, handle(&t.kb.clone(), &o.transfer_id.clone())),
        ErrorCode::NotFound,
    );
    assert_eq!(t.active(), 1);
    t.db()
        .execute(
            "UPDATE principal_ceilings SET bits=0 WHERE principal_id=?1",
            [p.id()],
        )
        .expect("fixture operation");
    code(t.read(&p, &o.transfer_id, 1, None), ErrorCode::NotFound);
    code(
        t.prepare(&p, "whole", "reader-export-0000", None),
        ErrorCode::NotFound,
    );
    t.db()
        .execute(
            "UPDATE principal_ceilings SET bits=1 WHERE principal_id=?1",
            [p.id()],
        )
        .expect("fixture operation");
    assert!(t.read(&p, &o.transfer_id, 1, Some(1)).is_ok());
    let other=t.s.bases_create(&t.s.owner(),input::<BasesCreate>(json!({"name":"Other","slug":"other","description":"Different knowledge base","idempotencyKey":"create-other-000000"}))).expect("fixture operation").kb.id;
    code(
        t.s.transfer_read(&t.s.owner(), frame(&other, &o.transfer_id.clone(), 0, None)),
        ErrorCode::NotFound,
    );
    t.s.advance_clock_for_tests(899);
    assert!(t.read(&p, &o.transfer_id, 2, Some(1)).is_ok());
    t.s.advance_clock_for_tests(1);
    code(t.read(&p, &o.transfer_id, 2, None), ErrorCode::NotFound);
    t.s.sweep_exports().expect("fixture operation");
    assert_eq!(t.active(), 0);
    assert!(!t.artifact(&o.transfer_id).exists());
}
#[test]
fn random_offsets_retries_and_eof_ack_grace_hold_slots_without_extension() {
    let t = Setup::new("frames");
    // Control expiry from creation, before slow fixture I/O or frame checks.
    // A future epoch also keeps the real background sweep out of this fixture.
    t.s.set_cursor_clock_for_tests(4_102_444_800);
    t.snapshot(&["large.pdf".into()], &pdf(500000), &[]);
    let p = t.s.owner();
    let o = t
        .prepare(&p, "whole", "frames-export-0000", None)
        .expect("fixture operation");
    let bytes = reconstruct(&t, &p, &o);
    for (offset, max) in [(0, 1), (196607, 196608), (196608, 11), (o.size - 1, 1)] {
        let f = t
            .read(&p, &o.transfer_id, offset, Some(max))
            .expect("fixture operation");
        assert_eq!(
            STANDARD.decode(&f.bytes_base64).expect("fixture operation"),
            bytes[offset as usize..f.next_offset as usize]
        );
        let retry = t
            .read(&p, &o.transfer_id, offset, Some(max))
            .expect("fixture operation");
        assert_eq!(f.bytes_base64, retry.bytes_base64);
        assert_eq!(f.eof, f.next_offset == o.size);
    }
    for (offset, max) in [
        (o.size, Some(1)),
        (u64::MAX, None),
        (0, Some(0)),
        (0, Some(196609)),
    ] {
        code(
            t.read(&p, &o.transfer_id, offset, max),
            ErrorCode::InvalidArgument,
        );
    }
    code(
        t.prepare(&p, "whole", "second-export-0000", None),
        ErrorCode::QuotaExceeded,
    );
    assert_eq!(t.active(), 1);
    t.s.advance_clock_for_tests(580);
    t.read(&p, &o.transfer_id, o.size - 1, Some(1))
        .expect("fixture operation");
    t.s.advance_clock_for_tests(22);
    code(t.read(&p, &o.transfer_id, 0, None), ErrorCode::NotFound);
    t.s.sweep_exports().expect("fixture operation");
    assert_eq!(t.active(), 0);
    let n = t
        .prepare(&p, "assets", "after-grace-000000", None)
        .expect("fixture operation");
    t.complete(&n.transfer_id);
    t.complete(&n.transfer_id);
    assert_eq!(t.active(), 0);
}
#[test]
fn store_concurrency_is_two_and_one_per_actor_even_after_restart() {
    let t = Setup::new("slots");
    let p = t.principal();
    let q = t.principal();
    let a = t
        .prepare(&p, "assets", "slot-a-export-0000", None)
        .expect("fixture operation");
    let b = t
        .prepare(&q, "whole", "slot-b-export-0000", None)
        .expect("fixture operation");
    code(
        t.prepare(&t.s.owner(), "whole", "slot-c-export-0000", None),
        ErrorCode::QuotaExceeded,
    );
    let s = Store::open(t.s.paths().root()).expect("fixture operation");
    code(
        s.export_prepare(
            &p,
            input::<ExportPrepare>(
                json!({"kbId":t.kb,"kind":"assets","idempotencyKey":"slot-d-export-0000"}),
            ),
        ),
        ErrorCode::QuotaExceeded,
    );
    s.transfer_read(&p, frame(&t.kb.clone(), &a.transfer_id.clone(), 0, None))
        .expect("fixture operation");
    s.export_complete(&p, handle(&t.kb.clone(), &a.transfer_id))
        .expect("fixture operation");
    s.export_complete(&q, handle(&t.kb.clone(), &b.transfer_id))
        .expect("fixture operation");
    assert_eq!(t.active(), 0);
}
#[test]
fn missing_corrupt_member_and_tampered_artifact_fail_whole_operation_and_release() {
    for missing in [false, true] {
        let t = Setup::new("member");
        let bytes = pdf(128);
        t.snapshot(&["asset.pdf".into()], &bytes, &[]);
        let path = kb_local::cas::blob_path(t.s.paths(), &content_hash(&bytes));
        if missing {
            std::fs::remove_file(path).expect("fixture operation");
        } else {
            OpenOptions::new()
                .write(true)
                .open(path)
                .expect("fixture operation")
                .write_all(b"X")
                .expect("fixture operation");
        }
        code(
            t.prepare(&t.s.owner(), "whole", "corrupt-export-000", None),
            ErrorCode::StorageUnavailable,
        );
        assert_eq!(t.active(), 0);
        assert_eq!(
            std::fs::read_dir(t.s.paths().assets_dir().join("tmp"))
                .expect("fixture operation")
                .count(),
            0
        );
    }
    let t = Setup::new("artifact");
    let o = t
        .prepare(&t.s.owner(), "whole", "tamper-export-0000", None)
        .expect("fixture operation");
    let mut f = OpenOptions::new()
        .write(true)
        .open(t.artifact(&o.transfer_id))
        .expect("fixture operation");
    f.seek(SeekFrom::Start(10)).expect("fixture operation");
    f.write_all(b"X").expect("fixture operation");
    drop(f);
    code(
        t.read(&t.s.owner(), &o.transfer_id, 0, Some(1)),
        ErrorCode::StorageUnavailable,
    );
    assert_eq!(t.active(), 0);
    assert!(!t.artifact(&o.transfer_id).exists());
}
#[test]
fn cancellation_deadline_and_failure_cleanup_have_stable_receipts() {
    for stage in [
        ExportStage::Reserved,
        ExportStage::ArtifactOpened,
        ExportStage::MemberWritten,
        ExportStage::Durable,
        ExportStage::Ready,
    ] {
        let t = Setup::new("cancel");
        let c = ExportControl::default();
        let mut id = None;
        let o = t.s.export_prepare_controlled(
            &t.s.owner(),
            input::<ExportPrepare>(
                json!({"kbId":t.kb,"kind":"whole","idempotencyKey":"cancel-export-0000"}),
            ),
            &c,
            &mut |s, transfer| {
                id = Some(transfer.clone());
                if s == stage {
                    c.cancel();
                }
                Ok(())
            },
        );
        code(o, ErrorCode::Cancelled);
        assert_eq!(t.active(), 0);
        assert!(!t.artifact(&id.expect("fixture operation")).exists());
        code(
            t.prepare(&t.s.owner(), "whole", "cancel-export-0000", None),
            ErrorCode::Cancelled,
        );
        assert!(
            t.prepare(&t.s.owner(), "whole", "after-cancel-00000", None)
                .is_ok()
        );
    }
    let t = Setup::new("deadline");
    let c = ExportControl::with_timeout(Duration::ZERO);
    code(
        t.s.export_prepare_controlled(
            &t.s.owner(),
            input::<ExportPrepare>(
                json!({"kbId":t.kb,"kind":"whole","idempotencyKey":"timeout-export-000"}),
            ),
            &c,
            &mut |_, _| Ok(()),
        ),
        ErrorCode::DeadlineExceeded,
    );
    assert_eq!(t.active(), 0);
}
#[test]
fn crash_child() {
    let Ok(root) = std::env::var("KB_EXPORT_CRASH_ROOT") else {
        return;
    };
    let s = Store::open(std::path::Path::new(&root)).expect("fixture operation");
    let kb = KbId::parse(&std::env::var("KB_EXPORT_CRASH_KB").expect("fixture operation"))
        .expect("fixture operation");
    let target = std::env::var("KB_EXPORT_CRASH_STAGE").expect("fixture operation");
    let control = ExportControl::default();
    s.export_prepare_controlled(
        &s.owner(),
        input::<ExportPrepare>(
            json!({"kbId":kb,"kind":"whole","idempotencyKey":"crash-export-00000"}),
        ),
        &control,
        &mut |stage, id| {
            if target == "TerminalDurable" && stage == ExportStage::MemberWritten {
                control.cancel();
            }
            if format!("{stage:?}") == target {
                std::fs::write(std::path::Path::new(&root).join("crash-id"), id.as_str())
                    .expect("fixture operation");
                std::process::exit(86);
            }
            Ok(())
        },
    )
    .expect("fixture operation");
    panic!("stage not reached");
}
#[test]
fn restart_replay_discards_partial_artifacts_and_keeps_ready_receipt() {
    for stage in [
        ExportStage::Reserved,
        ExportStage::ArtifactOpened,
        ExportStage::MemberWritten,
        ExportStage::Durable,
        ExportStage::Ready,
        ExportStage::TerminalDurable,
    ] {
        let t = Setup::new("crash");
        let root = t.s.paths().root().to_path_buf();
        let kb = t.kb.clone();
        drop(t.s);
        let status = Command::new(std::env::current_exe().expect("fixture operation"))
            .args(["--exact", "crash_child", "--nocapture"])
            .env("KB_EXPORT_CRASH_ROOT", &root)
            .env("KB_EXPORT_CRASH_KB", kb.as_str())
            .env("KB_EXPORT_CRASH_STAGE", format!("{stage:?}"))
            .status()
            .expect("fixture operation");
        assert_eq!(status.code(), Some(86));
        let id = Uuid::parse(
            &std::fs::read_to_string(root.join("crash-id")).expect("fixture operation"),
        )
        .expect("fixture operation");
        let s = Store::open(&root).expect("fixture operation");
        let replay = s.export_prepare(
            &s.owner(),
            input::<ExportPrepare>(
                json!({"kbId":kb,"kind":"whole","idempotencyKey":"crash-export-00000"}),
            ),
        );
        let path = s
            .paths()
            .assets_dir()
            .join("tmp")
            .join(format!("export-{id}"));
        if stage == ExportStage::Ready {
            assert_eq!(replay.expect("fixture operation").transfer_id, id);
            assert!(
                s.transfer_read(&s.owner(), frame(&kb.clone(), &id.clone(), 0, None))
                    .is_ok()
            );
            s.export_complete(&s.owner(), handle(&kb, &id))
                .expect("fixture operation");
        } else {
            code(replay, ErrorCode::Cancelled);
            assert!(!path.exists());
            let count: i64 = Connection::open(s.paths().state_db())
                .expect("fixture operation")
                .query_row(
                    "SELECT count(*) FROM export_artifacts WHERE state IN ('WRITING','READY')",
                    [],
                    |r| r.get(0),
                )
                .expect("fixture operation");
            assert_eq!(count, 0);
            assert!(
                s.export_prepare(
                    &s.owner(),
                    input::<ExportPrepare>(
                        json!({"kbId":kb,"kind":"whole","idempotencyKey":"after-crash-000000"})
                    )
                )
                .is_ok()
            );
        }
    }
}

#[test]
fn parked_child() {
    let Ok(root) = std::env::var("KB_EXPORT_PARK_ROOT") else {
        return;
    };
    let s = Store::open(std::path::Path::new(&root)).expect("fixture operation");
    let kb = KbId::parse(&std::env::var("KB_EXPORT_PARK_KB").expect("fixture operation"))
        .expect("fixture operation");
    let bin =
        std::path::PathBuf::from(std::env::var("KB_EXPORT_PARK_BIN").expect("fixture operation"));
    let timeout = std::env::var("KB_EXPORT_PARK_TIMEOUT").is_ok();
    let writing = std::env::var("KB_EXPORT_PARK_WRITING").is_ok();
    let recovery = std::env::var("KB_EXPORT_PARK_RECOVERY").is_ok();
    if recovery {
        let db = Connection::open(s.paths().state_db()).unwrap();
        db.execute("INSERT INTO operation_intents(op_id,actor_key,kb_id,operation,idempotency_key,request_hash,phase,expected_old,created_at) SELECT '00000000-0000-4000-8000-000000000056',?1,id,'COMMIT','recovery-pending-00',?2,'PREPARED',head_sha,created_at FROM kbs WHERE id=?3",(s.owner().actor_key(),content_hash(b"pending").as_str(),kb.as_str())).unwrap();
        std::fs::write(bin.join("mode"), b"for-each-ref").unwrap();
    }
    // Advance the operation clock only when the selected child acknowledges
    // readiness. Preflight is not a race against a marker timeout, and expiry
    // does not spend two real seconds of the child-drain assertion's budget.
    static EPOCH: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    static EXPIRED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    fn admitted_clock() -> std::time::Instant {
        *EPOCH.get().expect("clock initialized")
            + if EXPIRED.load(std::sync::atomic::Ordering::Acquire) {
                Duration::from_secs(2)
            } else {
                Duration::ZERO
            }
    }
    EPOCH.set(std::time::Instant::now()).unwrap();
    let c = if timeout {
        ExportControl::with_timeout_and_clock(Duration::from_secs(2), admitted_clock)
    } else {
        ExportControl::default()
    };
    let cancel = c.clone();
    let probe_bin = bin.clone();
    let db_path = s.paths().state_db().to_path_buf();
    let (settled, settlement) = std::sync::mpsc::channel();
    let watcher = std::thread::spawn(move || {
        let probe = parked_git::ParkedGit {
            bin: probe_bin,
            path: String::new(),
        };
        // The service/child watchdogs already bound preflight. Observe its
        // completion as well as readiness, so an early error fails directly.
        while !probe.bin.join("mark").exists() {
            assert!(
                matches!(
                    settlement.try_recv(),
                    Err(std::sync::mpsc::TryRecvError::Empty)
                ),
                "export settled before the selected Git child parked"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(probe.alive(), "selected Git must be alive at admission");
        // Deliberately hold terminal receipt persistence behind a SQLite
        // writer. Reaping must precede it; storage latency is not child drain.
        let rollback = writing.then(|| {
            let db = Connection::open(db_path).expect("rollback blocker");
            db.execute_batch("BEGIN IMMEDIATE").expect("hold rollback");
            db
        });
        let started = std::time::Instant::now();
        if timeout {
            EXPIRED.store(true, std::sync::atomic::Ordering::Release);
        } else {
            cancel.cancel();
        }
        while probe.alive() && started.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            !probe.alive(),
            "cancellation/expiry must reap the selected child within 3s"
        );
        if writing {
            assert!(
                matches!(
                    settlement.try_recv(),
                    Err(std::sync::mpsc::TryRecvError::Empty)
                ),
                "receipt settlement must wait for the held SQLite writer"
            );
        }
        drop(rollback);
        // Still require full synchronous settlement and durable cleanup; it
        // is intentionally independent of the short process-drain assertion.
        settlement.recv().expect("export service settlement");
    });
    let probe = parked_git::ParkedGit {
        bin: bin.clone(),
        path: String::new(),
    };
    let result = s.export_prepare_controlled(
        &s.owner(),
        input::<ExportPrepare>(
            json!({"kbId":kb,"kind":"whole","idempotencyKey":"parked-export-0000"}),
        ),
        &c,
        &mut |stage, _| {
            if writing && stage == ExportStage::Reserved {
                std::fs::write(bin.join("mode"), b"cat-file").expect("arm writer park");
            }
            Ok(())
        },
    );
    assert!(
        !probe.alive(),
        "export service must reap the selected child before returning"
    );
    // Join first so an observer failure reports its cause, not SendError.
    let _ = settled.send(());
    watcher.join().expect("Git drain observer");
    code(
        result,
        if timeout {
            ErrorCode::DeadlineExceeded
        } else {
            ErrorCode::Cancelled
        },
    );
    if recovery {
        let db = Connection::open(s.paths().state_db()).unwrap();
        assert_eq!(
            db.query_row("SELECT state FROM kbs WHERE id=?1", [kb.as_str()], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "ACTIVE"
        );
        assert_eq!(
            db.query_row(
                "SELECT phase FROM operation_intents WHERE idempotency_key='recovery-pending-00'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "PREPARED"
        );
    }
    std::fs::write(bin.join("release"), b"go").expect("fixture operation");
    if writing {
        code(
            s.export_prepare(
                &s.owner(),
                input::<ExportPrepare>(
                    json!({"kbId":kb,"kind":"whole","idempotencyKey":"parked-export-0000"}),
                ),
            ),
            if timeout {
                ErrorCode::DeadlineExceeded
            } else {
                ErrorCode::Cancelled
            },
        );
    }
    assert!(
        s.export_prepare(
            &s.owner(),
            input::<ExportPrepare>(
                json!({"kbId":kb,"kind":"whole","idempotencyKey":"after-parked-00000"})
            )
        )
        .is_ok()
    );
}
#[test]
fn cancellation_and_deadline_drain_blocked_git_and_allow_reentry() {
    for (timeout, writing, recovery) in [
        (false, false, false),
        (true, false, false),
        (false, true, false),
        (true, true, false),
        (false, false, true),
        (true, false, true),
    ] {
        let t = Setup::new("parked");
        let parked = parked_git::ParkedGit::new(
            &t.f.root,
            if writing || recovery {
                "unselected"
            } else {
                "cat-file"
            },
        );
        if writing {
            std::fs::write(parked.bin.join("delay-unselected-cat-file"), b"3000")
                .expect("slow preflight fault");
        }
        let mut cmd = Command::new(std::env::current_exe().expect("fixture operation"));
        cmd.args(["--exact", "parked_child"])
            .env("PATH", &parked.path)
            .env("KB_EXPORT_PARK_ROOT", t.s.paths().root())
            .env("KB_EXPORT_PARK_KB", t.kb.as_str())
            .env("KB_EXPORT_PARK_BIN", &parked.bin);
        if timeout {
            cmd.env("KB_EXPORT_PARK_TIMEOUT", "1");
        }
        if writing {
            cmd.env("KB_EXPORT_PARK_WRITING", "1");
        }
        if recovery {
            cmd.env("KB_EXPORT_PARK_RECOVERY", "1");
        }
        let output = fixture::ChildGuard::spawn_capture(&cmd)
            .expect("parked fixture")
            .wait_with_output()
            .expect("parked fixture settlement");
        assert!(
            output.status.success(),
            "parked fixture failed: timeout={timeout}, writing={writing}, recovery={recovery}\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
        // The successful child has already observed readiness.
        parked.wait("mark");
        assert!(!parked.alive());
        if writing {
            assert!(parked.bin.join("preflight-delayed").exists());
        }
        #[cfg(unix)]
        assert!(fixture::os_locks_available(
            t.s.paths().root(),
            std::slice::from_ref(&t.kb)
        ));
    }
}
#[test]
fn expired_export_before_admission_creates_no_child_or_receipt() {
    let t = Setup::new("expired-before-admission");
    // Real-clock expiry before admission is a distinct path from expiry of an
    // admitted, blocked child. It must not perform preflight or reserve a row.
    let c = ExportControl::with_timeout(Duration::ZERO);
    let started = std::time::Instant::now();
    code(
        t.s.export_prepare_controlled(
            &t.s.owner(),
            input::<ExportPrepare>(json!({
                "kbId":t.kb,"kind":"whole","idempotencyKey":"expired-export-00"
            })),
            &c,
            &mut |_, _| panic!("expired operation must not reach writer admission"),
        ),
        ErrorCode::DeadlineExceeded,
    );
    assert!(started.elapsed() < Duration::from_secs(3));
    let count: i64 = Connection::open(t.s.paths().state_db())
        .unwrap()
        .query_row("SELECT count(*) FROM export_artifacts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0, "pre-admission expiry must not reserve a receipt");
    assert_eq!(t.active(), 0);
}

#[test]
fn minute_timer_and_unlink_failure_retry_reclaim_only_artifacts() {
    // Nonblocking ticks may defer while another test's Git spawn holds the
    // process-wide lock registry. Isolate uncontended admission, as in the
    // upload expiry test, while still exercising the real timer and storage.
    if std::env::var_os("KB_EXPORT_TIMER_TEST_CHILD").is_none() {
        let output = Command::new(std::env::current_exe().expect("fixture executable"))
            .args([
                "--exact",
                "minute_timer_and_unlink_failure_retry_reclaim_only_artifacts",
                "--nocapture",
            ])
            .env("KB_EXPORT_TIMER_TEST_CHILD", "1")
            .stdin(std::process::Stdio::null())
            .output()
            .expect("spawn timer test");
        assert!(
            output.status.success(),
            "timer child failed: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout)
                .contains("test result: ok. 1 passed; 0 failed;"),
            "timer child must execute exactly one test"
        );
        return;
    }
    let t = Setup::new("timer");
    let payload = pdf(128);
    t.snapshot(&["kept.pdf".into()], &payload, &[]);
    let o = t
        .prepare(&t.s.owner(), "whole", "timer-export-00000", None)
        .expect("fixture operation");
    let path = t.artifact(&o.transfer_id);
    std::fs::remove_file(&path).expect("fixture operation");
    std::fs::create_dir(&path).expect("fixture operation");
    assert!(
        t.s.export_complete(&t.s.owner(), handle(&t.kb, &o.transfer_id))
            .is_err()
    );
    assert_eq!(t.active(), 0);
    code(
        t.read(&t.s.owner(), &o.transfer_id, 0, None),
        ErrorCode::NotFound,
    );
    std::fs::remove_dir(&path).expect("fixture operation");
    t.db()
        .execute(
            "UPDATE export_artifacts SET retry_ms=0 WHERE id=?1",
            [o.transfer_id.as_str()],
        )
        .expect("fixture operation");
    t.s.run_upload_timer_for_tests().expect("fixture operation");
    assert_eq!(
        t.db()
            .query_row(
                "SELECT reclaimed FROM export_artifacts WHERE id=?1",
                [o.transfer_id.as_str()],
                |r| r.get::<_, i64>(0)
            )
            .expect("fixture operation"),
        1
    );
    let n = t
        .prepare(&t.s.owner(), "whole", "timer-expired-0000", None)
        .expect("fixture operation");
    let reader = t.principal();
    let live = t
        .prepare(&reader, "whole", "timer-live-0000000", None)
        .expect("live export");
    let guard = t.s.lock_write(&[]).expect("producer fence");
    t.db()
        .execute(
            "UPDATE export_artifacts SET expires_ms=0 WHERE id=?1",
            [n.transfer_id.as_str()],
        )
        .expect("fixture operation");
    t.s.run_upload_timer_for_tests().expect("busy timer tick");
    assert_eq!(t.active(), 2);
    assert!(t.artifact(&n.transfer_id).exists());
    drop(guard);
    t.s.run_upload_timer_for_tests().expect("fixture operation");
    assert_eq!(t.active(), 1);
    assert!(!t.artifact(&n.transfer_id).exists());
    assert!(t.artifact(&live.transfer_id).exists());
    assert!(t.read(&reader, &live.transfer_id, 0, None).is_ok());
    t.s.export_complete(&reader, handle(&t.kb, &live.transfer_id))
        .expect("complete live export");
    assert_eq!(t.active(), 0);
    assert!(kb_local::cas::blob_path(t.s.paths(), &content_hash(&payload)).exists());
    assert!(
        t.s.documents_get(
            &t.s.owner(),
            input::<DocumentsGet>(json!({"kbId":t.kb,"path":"index.md"}))
        )
        .is_ok()
    );
}
#[test]
fn corrupt_git_blob_fails_even_when_replacement_is_valid_markdown() {
    let t = Setup::new("git-corrupt");
    let rev = t.snapshot(&[], &pdf(128), &[("index.md", b"original markdown")]);
    let old = t.f.git(&["rev-parse", &format!("{rev}:index.md")]);
    let replacement = t.f.blob(b"modified markdown");
    let object = |sha: &str| t.f.repo.join("objects").join(&sha[..2]).join(&sha[2..]);
    std::fs::remove_file(object(&old)).expect("fixture operation");
    std::fs::copy(object(&replacement), object(&old)).expect("fixture operation");
    code(
        t.prepare(&t.s.owner(), "whole", "bad-git-export-000", Some(&rev)),
        ErrorCode::StorageUnavailable,
    );
    assert_eq!(t.active(), 0);
}

#[test]
fn fresh_exports_charge_shared_window_but_replay_frames_and_ack_are_exempt() {
    let t = Setup::new("rate");
    // Slow fixture I/O must not expire the rolling window between assertions.
    // Budget charges and replays share one fixed instant; the expiry edge is
    // reached by advancing this test clock explicitly.
    let now = 4_102_444_800_000;
    t.s.set_cursor_clock_for_tests(now / 1000);
    let p = t.principal();
    let window = |times: Value| {
        t.db().execute("INSERT INTO mutation_windows(actor_key,kb_id,times_json) VALUES (?1,?2,?3) ON CONFLICT(actor_key,kb_id) DO UPDATE SET times_json=excluded.times_json",(p.actor_key(),t.kb.as_str(),times.to_string())).expect("window");
    };
    // The local per-actor, per-KB write window.
    let full = kb_local::limits::LOCAL_MUTATIONS_PER_MINUTE_PER_KB;
    window(json!(vec![now; full]));
    code(
        t.prepare(&p, "whole", "rate-export-00000", None),
        ErrorCode::RateLimited,
    );
    assert_eq!(t.active(), 0);
    assert_eq!(
        t.db()
            .query_row("SELECT count(*) FROM export_artifacts", [], |r| r
                .get::<_, i64>(0))
            .expect("receipts"),
        0
    );
    window(json!(vec![now; full - 1]));
    let out = t
        .prepare(&p, "whole", "rate-export-00000", None)
        .expect("last admission");
    let times: String = t
        .db()
        .query_row(
            "SELECT times_json FROM mutation_windows WHERE actor_key=?1 AND kb_id=?2",
            (p.actor_key(), t.kb.as_str()),
            |r| r.get(0),
        )
        .expect("window");
    assert_eq!(
        serde_json::from_str::<Vec<u64>>(&times)
            .expect("times")
            .len(),
        full
    );
    assert_eq!(
        t.prepare(&p, "whole", "rate-export-00000", None)
            .expect("replay")
            .transfer_id,
        out.transfer_id
    );
    reconstruct(&t, &p, &out);
    t.s.export_complete(&p, handle(&t.kb, &out.transfer_id))
        .expect("ack");
    code(
        t.prepare(&p, "assets", "rate-export-next0", None),
        ErrorCode::RateLimited,
    );
    t.s.advance_clock_for_tests(59);
    code(
        t.prepare(&p, "assets", "rate-export-next0", None),
        ErrorCode::RateLimited,
    );
    t.s.advance_clock_for_tests(1);
    let next = t
        .prepare(&p, "assets", "rate-export-next0", None)
        .expect("expired window");
    t.s.export_complete(&p, handle(&t.kb, &next.transfer_id))
        .expect("ack");
    window(json!(["corrupt"]));
    code(
        t.prepare(&p, "assets", "rate-export-bad00", None),
        ErrorCode::RepairRequired,
    );
}

#[test]
fn controlled_lock_admission_cancels_times_out_and_preserves_other_owner() {
    for store_lock in [true, false] {
        for timeout in [true, false] {
            let t = Setup::new("lock-control");
            drop(
                t.s.lock_write(std::slice::from_ref(&t.kb))
                    .expect("initialize lock files"),
            );
            let path = if store_lock {
                t.s.paths().store_lock_file()
            } else {
                t.s.paths().kb_lock_file(&t.kb)
            };
            let held = OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)
                .expect("lock file");
            held.lock().expect("other owner");
            let c = ExportControl::with_timeout(if timeout {
                Duration::from_millis(100)
            } else {
                Duration::from_secs(120)
            });
            let signal = c.clone();
            let worker = std::thread::spawn(move || {
                if !timeout {
                    std::thread::sleep(Duration::from_millis(50));
                    signal.cancel();
                }
            });
            let start = std::time::Instant::now();
            code(
                t.s.export_prepare_controlled(
                    &t.s.owner(),
                    input::<ExportPrepare>(
                        json!({"kbId":t.kb,"kind":"whole","idempotencyKey":"lock-export-00000"}),
                    ),
                    &c,
                    &mut |_, _| panic!("no admission"),
                ),
                if timeout {
                    ErrorCode::DeadlineExceeded
                } else {
                    ErrorCode::Cancelled
                },
            );
            worker.join().expect("cancel worker");
            assert!(start.elapsed() < Duration::from_secs(1));
            let probe = OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)
                .expect("probe");
            assert!(matches!(
                probe.try_lock(),
                Err(std::fs::TryLockError::WouldBlock)
            ));
            assert_eq!(t.active(), 0);
            held.unlock().expect("owner release");
            t.prepare(&t.s.owner(), "whole", "lock-export-00000", None)
                .expect("fresh control re-entry");
        }
    }
}

#[test]
fn timer_cleanup_failure_cannot_starve_sibling_retention_class() {
    if std::env::var_os("KB_EXPORT_SWEEP_TEST_CHILD").is_none() {
        let out = Command::new(std::env::current_exe().expect("exe"))
            .args([
                "--exact",
                "timer_cleanup_failure_cannot_starve_sibling_retention_class",
                "--nocapture",
            ])
            .env("KB_EXPORT_SWEEP_TEST_CHILD", "1")
            .output()
            .expect("child");
        assert!(
            out.status.success(),
            "{} {}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(
            String::from_utf8_lossy(&out.stdout).contains("test result: ok. 1 passed; 0 failed;")
        );
        return;
    }
    for startup in [true, false] {
        for failed_class in ["upload", "export", "cas"] {
            let failed_upload = failed_class == "upload";
            let failed_export = failed_class == "export";
            let t = Setup::new("sibling-retention");
            let bytes = pdf(128);
            let upload=t.s.upload_begin(&t.s.owner(),input::<UploadBegin>(json!({"kbId":t.kb,"kind":"asset","mime":"application/pdf","size":bytes.len(),"contentHash":content_hash(&bytes),"idempotencyKey":"sweep-upload-0000"}))).expect("upload");
            let upload_path = t.s.paths().uploads_dir().join(upload.upload_id.as_str());
            let export = t
                .prepare(&t.s.owner(), "whole", "sweep-export-0000", None)
                .expect("export");
            let export_path = t.artifact(&export.transfer_id);
            let cas_path =
                t.s.paths()
                    .assets_dir()
                    .join("tmp/cas-00000000-0000-4000-8000-000000000056");
            let bad = match failed_class {
                "upload" => &upload_path,
                "export" => &export_path,
                _ => &cas_path,
            };
            if failed_upload || failed_export {
                std::fs::remove_file(bad).expect("remove owned file");
            }
            std::fs::create_dir(bad).expect("force EISDIR");
            t.db()
                .execute(
                    "UPDATE staged_uploads SET expires_ms=0 WHERE id=?1",
                    [upload.upload_id.as_str()],
                )
                .expect("expire upload");
            t.db()
                .execute(
                    "UPDATE export_artifacts SET expires_ms=0 WHERE id=?1",
                    [export.transfer_id.as_str()],
                )
                .expect("expire export");
            if startup {
                assert!(Store::open(t.s.paths().root()).is_err());
            } else {
                assert!(t.s.run_upload_timer_for_tests().is_err());
            }
            let reclaimed = |table: &str, id: &str| {
                t.db()
                    .query_row(
                        &format!("SELECT reclaimed FROM {table} WHERE id=?1"),
                        [id],
                        |r| r.get::<_, i64>(0),
                    )
                    .expect("reclaimed")
            };
            assert_eq!(
                reclaimed("staged_uploads", upload.upload_id.as_str()),
                i64::from(!failed_upload)
            );
            assert_eq!(
                reclaimed("export_artifacts", export.transfer_id.as_str()),
                i64::from(!failed_export)
            );
            assert_eq!(t.active(), 0);
            assert!(bad.is_dir());
            if !failed_upload {
                assert!(!upload_path.exists());
            }
            if !failed_export {
                assert!(!export_path.exists());
            }
            std::fs::remove_dir(bad).expect("repair owned path");
            t.db()
                .execute(
                    "UPDATE staged_uploads SET retry_ms=0 WHERE id=?1",
                    [upload.upload_id.as_str()],
                )
                .expect("retry");
            t.db()
                .execute(
                    "UPDATE export_artifacts SET retry_ms=0 WHERE id=?1",
                    [export.transfer_id.as_str()],
                )
                .expect("retry");
            t.s.run_upload_timer_for_tests().expect("retry both");
            assert_eq!(reclaimed("staged_uploads", upload.upload_id.as_str()), 1);
            assert_eq!(
                reclaimed("export_artifacts", export.transfer_id.as_str()),
                1
            );
            assert!(
                t.s.documents_get(
                    &t.s.owner(),
                    input::<DocumentsGet>(json!({"kbId":t.kb,"path":"index.md"}))
                )
                .is_ok()
            );
        }
    }
}

#[test]
fn disk_admission_preserves_floor_overhead_pending_bytes_and_exact_limits() {
    use kb_local::{git_read::GitRepo, limits::FREE_DISK_FLOOR_BYTES};
    use std::path::Path;
    fn short(_: &GitRepo, _: &Path) -> Result<u64, StoreError> {
        Ok(FREE_DISK_FLOOR_BYTES + 21)
    }
    fn exact(_: &GitRepo, _: &Path) -> Result<u64, StoreError> {
        Ok(FREE_DISK_FLOOR_BYTES + 22)
    }
    fn unavailable(_: &GitRepo, _: &Path) -> Result<u64, StoreError> {
        Err(StoreError::Io(std::io::Error::from(
            std::io::ErrorKind::PermissionDenied,
        )))
    }
    let t = Setup::new("disk-admission");
    for (meter, expected) in [
        (
            short as fn(&GitRepo, &Path) -> Result<u64, StoreError>,
            ErrorCode::QuotaExceeded,
        ),
        (unavailable, ErrorCode::StorageUnavailable),
    ] {
        let c = ExportControl::default().with_disk_meter(meter);
        code(
            t.s.export_prepare_controlled(
                &t.s.owner(),
                input::<ExportPrepare>(
                    json!({"kbId":t.kb,"kind":"assets","idempotencyKey":"disk-export-00000"}),
                ),
                &c,
                &mut |_, _| panic!("no reservation before admission"),
            ),
            expected,
        );
        assert_eq!(t.active(), 0);
        assert_eq!(
            t.db()
                .query_row("SELECT count(*) FROM export_artifacts", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            std::fs::read_dir(t.s.paths().assets_dir().join("tmp"))
                .unwrap()
                .count(),
            0
        );
    }
    let c = ExportControl::default().with_disk_meter(exact);
    let o =
        t.s.export_prepare_controlled(
            &t.s.owner(),
            input::<ExportPrepare>(
                json!({"kbId":t.kb,"kind":"assets","idempotencyKey":"disk-export-00000"}),
            ),
            &c,
            &mut |_, _| Ok(()),
        )
        .unwrap();
    assert_eq!(o.size, 22);
    t.complete(&o.transfer_id);
    let bytes = pdf(128);
    t.s.upload_begin(&t.s.owner(),input::<UploadBegin>(json!({"kbId":t.kb,"kind":"asset","mime":"application/pdf","size":bytes.len(),"contentHash":content_hash(&bytes),"idempotencyKey":"disk-upload-00000"}))).unwrap();
    code(
        t.s.export_prepare_controlled(
            &t.s.owner(),
            input::<ExportPrepare>(
                json!({"kbId":t.kb,"kind":"assets","idempotencyKey":"disk-pending-0000"}),
            ),
            &c,
            &mut |_, _| panic!("pending upload needs space"),
        ),
        ErrorCode::QuotaExceeded,
    );
    // Replays use the already allocated artifact, even if disk measurement fails.
    let p = t.principal();
    let o = t.prepare(&p, "assets", "disk-reader-00000", None).unwrap();
    let c = ExportControl::default().with_disk_meter(unavailable);
    assert_eq!(
        t.s.export_prepare_controlled(
            &p,
            input::<ExportPrepare>(
                json!({"kbId":t.kb,"kind":"assets","idempotencyKey":"disk-reader-00000"})
            ),
            &c,
            &mut |_, _| panic!("no fresh replay")
        )
        .unwrap()
        .transfer_id,
        o.transfer_id
    );
}

#[test]
fn exact_256_mib_assets_fit_with_exact_zip_disk_reservation() {
    const ARCHIVE: u64 = 256 * 1024 * 1024 + 16 * (92 + 2 * 6) + 22;
    fn meter(_: &kb_local::git_read::GitRepo, _: &std::path::Path) -> Result<u64, StoreError> {
        Ok(kb_local::limits::FREE_DISK_FLOOR_BYTES + ARCHIVE)
    }
    let t = Setup::new("256mib-disk");
    t.snapshot(
        &(0..16).map(|i| format!("{i:02}.pdf")).collect::<Vec<_>>(),
        &pdf(16 * 1024 * 1024),
        &[],
    );
    let c = ExportControl::default().with_disk_meter(meter);
    let out =
        t.s.export_prepare_controlled(
            &t.s.owner(),
            input::<ExportPrepare>(
                json!({"kbId":t.kb,"kind":"assets","idempotencyKey":"exact-disk-000000"}),
            ),
            &c,
            &mut |_, _| Ok(()),
        )
        .unwrap();
    assert_eq!(out.size, ARCHIVE);
    assert_eq!(
        std::fs::metadata(t.artifact(&out.transfer_id))
            .unwrap()
            .len(),
        ARCHIVE
    );
    t.complete(&out.transfer_id);
    assert_eq!(t.active(), 0);
}
