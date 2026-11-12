//! Spec-first tests: real Git/SQLite/files, shared media, no mocked boundary.
use base64::{Engine, engine::general_purpose::STANDARD};
use kb_client::{
    ErrorCode, decode_input,
    schema::{Direction, validate},
    snapshot::content_hash,
    types::*,
};
use kb_local::{LocalPrincipal, PrincipalKind, Stage, Store, StoreError};
use serde_json::{Value, json};
use std::process::{Command, Stdio};
#[path = "support/fixture.rs"]
mod fixture;

fn input<T: Tool>(v: Value) -> T::Input {
    decode_input::<T>(v).expect("fixture input")
}
fn wire<T: Tool>(out: &T::Output) {
    validate(
        T::NAME.as_str(),
        Direction::Output,
        &serde_json::to_value(out).expect("JSON"),
    )
    .expect("wire output");
}
fn kb(s: &Store, slug: &str) -> KbId {
    s.bases_create(&s.owner(), input::<BasesCreate>(json!({"name":"Manifest","slug":slug,"description":"Manifest lineage fixture knowledge base","idempotencyKey":format!("create-{slug}-00000000")}))).expect("KB").kb.id
}
fn head(s: &Store, kb: &KbId) -> Sha {
    Sha::parse(
        s.read_kb(kb)
            .expect("record")
            .head_sha
            .as_deref()
            .expect("head"),
    )
    .expect("SHA")
}
fn media(name: &str) -> Vec<u8> {
    let ts = include_str!("../../../../../packages/api/src/lib/kb/fixtures/media-bytes.ts");
    let body = ts
        .split(&format!("export function {name}(): Buffer {{"))
        .nth(1)
        .expect("shared media")
        .split("\n}")
        .next()
        .expect("body");
    let b64 = body
        .split('"')
        .enumerate()
        .filter(|(i, _)| i % 2 == 1)
        .map(|(_, s)| s)
        .take_while(|s| *s != "base64")
        .collect::<String>();
    STANDARD.decode(b64).expect("media")
}
fn png() -> Vec<u8> {
    media("minimalPng")
}

fn staged(s: &Store, who: &LocalPrincipal, kb: &KbId, bytes: &[u8], kind: &str, key: &str) -> Uuid {
    let b = s.upload_begin(who, input::<UploadBegin>(json!({"kbId":kb,"kind":kind,"size":bytes.len(),"contentHash":content_hash(bytes),"mime":if kind=="asset" {if bytes.starts_with(b"%PDF") {"application/pdf"} else if bytes.starts_with(b"RIFF") {"audio/wav"} else {"image/png"}} else {"text/markdown"},"idempotencyKey":key}))).expect("begin");
    for (i, chunk) in bytes.chunks(196608).enumerate() {
        s.upload_write(
            who,
            UploadWriteInput {
                kb_id: kb.clone(),
                upload_id: b.upload_id.clone(),
                offset: (i * 196608) as u64,
                bytes_base64: STANDARD.encode(chunk),
            },
        )
        .expect("frame");
    }
    s.upload_finish(
        who,
        UploadRef {
            kb_id: kb.clone(),
            upload_id: b.upload_id.clone(),
        },
    )
    .expect("READY");
    b.upload_id
}
fn apply(
    s: &Store,
    who: &LocalPrincipal,
    kb: &KbId,
    base: &Sha,
    key: &str,
    changes: Value,
) -> Result<ApplyResult, StoreError> {
    let out=s.changes_apply(who,serde_json::from_value(json!({"kbId":kb,"baseRevision":base,"idempotencyKey":key,"mode":"edit","title":"Manifest edits","changes":changes,"sourceSessionIds":[]})).expect("typed input"));
    if let Ok(o) = &out {
        wire::<ChangesApply>(o);
    }
    out
}
fn list(s: &Store, who: &LocalPrincipal, kb: &KbId, rev: Option<&Sha>) -> Page<AssetRef> {
    let mut v = json!({"kbId":kb});
    if let Some(r) = rev {
        v["rev"] = json!(r);
    }
    let out = s.assets_list(who, input::<AssetsList>(v)).expect("assets");
    wire::<AssetsList>(&out);
    out
}
fn put(
    s: &Store,
    who: &LocalPrincipal,
    kb: &KbId,
    base: &Sha,
    id: &Uuid,
    path: &str,
    key: &str,
) -> Result<ApplyResult, StoreError> {
    let out = s.assets_put(
        who,
        input::<AssetsPut>(
            json!({"kbId":kb,"baseRevision":base,"idempotencyKey":key,"path":path,"uploadId":id}),
        ),
    );
    if let Ok(o) = &out {
        wire::<AssetsPut>(o);
    }
    out
}
fn import_input(
    kb: &KbId,
    base: &Sha,
    source: &KbId,
    rev: &Sha,
    hash: &ContentHash,
    key: &str,
) -> AssetsImportInput {
    input::<AssetsImport>(
        json!({"kbId":kb,"baseRevision":base,"idempotencyKey":key,"path":"copy.png","source":{"kbId":source,"rev":rev,"hash":hash}}),
    )
}
fn principal(s: &Store, kb: &KbId, bits: &[Permission]) -> LocalPrincipal {
    let g = s.lock_write(std::slice::from_ref(kb)).expect("lock");
    s.register_principal(&g, PrincipalKind::Test, kb, bits)
        .expect("principal")
}
fn grant(s: &Store, p: &LocalPrincipal, kb: &KbId, bits: &[Permission]) {
    let _g = s.lock_write(std::slice::from_ref(kb)).expect("lock");
    rusqlite::Connection::open(s.paths().state_db()).expect("DB").execute("INSERT INTO principal_ceilings(principal_id,kind,kb_id,bits) VALUES (?1,'TEST',?2,?3) ON CONFLICT(principal_id,kb_id) DO UPDATE SET bits=excluded.bits",(p.id(),kb.as_str(),bits.iter().fold(0i64,|raw,p|raw | match p {Permission::Read=>1,Permission::Propose=>2,Permission::Write=>4,Permission::Review=>8,Permission::Manage=>16}))).expect("fixture ceiling");
}

fn count(s: &Store, table: &str) -> i64 {
    rusqlite::Connection::open(s.paths().state_db())
        .expect("DB")
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .expect("count")
}
fn upload_state(s: &Store, id: &Uuid) -> (String, i64) {
    rusqlite::Connection::open(s.paths().state_db())
        .expect("DB")
        .query_row(
            "SELECT state,reserved FROM staged_uploads WHERE id=?1",
            [id.as_str()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("state")
}
fn rejected<T: std::fmt::Debug>(r: Result<T, StoreError>, code: ErrorCode) {
    assert_eq!(r.expect_err("reject").protocol_code(), code);
}

#[test]
fn full_32_operation_asset_and_staged_markdown_batches() {
    for mode in ["main", "proposal", "mixed"] {
        let f = fixture::Fixture::new(&format!("cap32-{mode}"));
        let s = Store::open(&f.root.join("store")).expect("store");
        let k = kb(&s, &format!("cap32-{mode}"));
        let who = if mode == "proposal" {
            principal(&s, &k, &[Permission::Propose])
        } else {
            s.owner()
        };
        let base = head(&s, &k);
        let mut changes = Vec::new();
        let mut assets = 0;
        for i in 0..32 {
            if mode == "mixed" && i % 2 == 1 {
                let id = staged(
                    &s,
                    &who,
                    &k,
                    format!("# Document {i}\n").as_bytes(),
                    "markdown",
                    &format!("stage-text-{i:05}"),
                );
                changes.push(
                    json!({"op":"create","path":format!("docs/{i}.md"),"content":{"uploadId":id}}),
                );
            } else {
                // Change one PCM sample in a valid WAV so all 32 assets have
                // distinct content hashes without bypassing media validation.
                let mut bytes = media("minimalWav");
                *bytes.last_mut().expect("PCM sample") = 128 + i as u8;
                let id = staged(
                    &s,
                    &who,
                    &k,
                    &bytes,
                    "asset",
                    &format!("stage-asset-{i:04}"),
                );
                changes
                    .push(json!({"op":"assetPut","path":format!("media/{i}.wav"),"uploadId":id}));
                assets += 1;
            }
        }
        let out =
            apply(&s, &who, &k, &base, "cap32-first-0001", json!(changes)).expect("32 changes");
        assert_eq!(out.changed_paths.len(), 32);
        assert_eq!(count(&s, "kb_asset_lineage"), assets);
        assert_eq!(
            apply(&s, &who, &k, &base, "cap32-first-0001", json!(changes)).expect("replay"),
            out
        );
        if mode == "proposal" {
            assert_eq!(head(&s, &k), base);
        }
        let removals: Vec<Value> = changes
            .iter()
            .filter(|c| c["op"] == "assetPut")
            .map(|c| json!({"op":"assetRemove","path":c["path"]}))
            .collect();
        let mut removal = json!({"kbId":k,"baseRevision":out.commit_sha,"idempotencyKey":"cap32-remove-001","mode":"edit","title":"Remove assets","sourceSessionIds":[],"changes":removals});
        if let Some(pr) = &out.proposal {
            removal["proposalNumber"] = json!(pr.number);
            removal["proposalHeadSha"] = json!(out.commit_sha);
        }
        let removed = s
            .changes_apply(&who, input::<ChangesApply>(removal))
            .expect("remove");
        wire::<ChangesApply>(&removed);
        assert_eq!(removed.changed_paths.len(), assets as usize);
    }
    let f = fixture::Fixture::new("cap32-staged");
    let s = Store::open(&f.root.join("store")).expect("store");
    let k = kb(&s, "staged-cap32");
    let who = s.owner();
    let mut base = head(&s, &k);
    for op in ["create", "replace"] {
        let changes: Vec<Value> = (0..32)
            .map(|i| {
                let id = staged(
                    &s,
                    &who,
                    &k,
                    format!("# {op} {i}\n").as_bytes(),
                    "markdown",
                    &format!("stage-{op}-{i:04}"),
                );
                json!({"op":op,"path":format!("docs/{i}.md"),"content":{"uploadId":id}})
            })
            .collect();
        let out = apply(
            &s,
            &who,
            &k,
            &base,
            &format!("cap32-{op}-0001"),
            json!(changes),
        )
        .expect("32 staged documents");
        assert_eq!(out.changed_paths.len(), 32);
        base = out.commit_sha;
    }
    let deleted = apply(
        &s,
        &who,
        &k,
        &base,
        "cap32-delete-0001",
        json!(
            (0..32)
                .map(|i| json!({"op":"delete","path":format!("docs/{i}.md")}))
                .collect::<Vec<_>>()
        ),
    )
    .expect("32 deletes");
    assert_eq!(deleted.changed_paths.len(), 32);
}

#[test]
fn asset_wrappers_keep_explicit_owned_proposal_for_write_holder() {
    let f = fixture::Fixture::new("asset-explicit-pr");
    let s = Store::open(&f.root.join("store")).expect("store");
    let k = kb(&s, "asset-proposal");
    let main = head(&s, &k);
    let author = principal(&s, &k, &[Permission::Propose]);
    let proposal = apply(
        &s,
        &author,
        &k,
        &main,
        "asset-pr-start-0001",
        json!([{"op":"create","path":"seed.md","content":{"markdown":"# seed\n"}}]),
    )
    .expect("proposal");
    let guard = s.lock_write(std::slice::from_ref(&k)).expect("lock");
    s.set_principal_permissions(&guard, &author, &k, &[Permission::Write])
        .expect("write permission");
    drop(guard);
    let bytes = png();
    let upload = staged(&s, &author, &k, &bytes, "asset", "asset-pr-upload-001");
    let intents = count(&s, "operation_intents");
    rejected(s.assets_put(&author, input::<AssetsPut>(json!({"kbId":k,"baseRevision":main,"proposalNumber":999,"idempotencyKey":"asset-pr-put-denied","path":"a.png","uploadId":upload}))), ErrorCode::NotFound);
    assert_eq!(head(&s, &k), main);
    assert_eq!(upload_state(&s, &upload).0, "READY");
    assert_eq!(count(&s, "operation_intents"), intents);
    let put = s.assets_put(&author, input::<AssetsPut>(json!({"kbId":k,"baseRevision":proposal.commit_sha,"proposalNumber":1,"proposalHeadSha":proposal.commit_sha,"idempotencyKey":"asset-pr-put-000001","path":"a.png","uploadId":upload}))).expect("put to proposal");
    wire::<AssetsPut>(&put);
    assert_eq!(put.kind, ApplyKind::Proposed);
    assert_eq!(put.proposal.as_ref().expect("pr").number, 1);
    assert_eq!(head(&s, &k), main);
    assert!(list(&s, &author, &k, None).items.is_empty());
    assert_eq!(list(&s, &author, &k, Some(&put.commit_sha)).items.len(), 1);
    let intents = count(&s, "operation_intents");
    rejected(s.assets_import(&author, input::<AssetsImport>(json!({"kbId":k,"baseRevision":main,"proposalNumber":999,"idempotencyKey":"asset-pr-import-denied","path":"b.png","source":{"kbId":k,"rev":put.commit_sha,"hash":content_hash(&bytes)}}))), ErrorCode::NotFound);
    assert_eq!(head(&s, &k), main);
    assert_eq!(count(&s, "operation_intents"), intents);
    let imported = s.assets_import(&author, input::<AssetsImport>(json!({"kbId":k,"baseRevision":put.commit_sha,"proposalNumber":1,"proposalHeadSha":put.commit_sha,"idempotencyKey":"asset-pr-import-001","path":"b.png","source":{"kbId":k,"rev":put.commit_sha,"hash":content_hash(&bytes)}}))).expect("import to proposal");
    wire::<AssetsImport>(&imported);
    assert_eq!(imported.kind, ApplyKind::Proposed);
    assert_eq!(imported.proposal.as_ref().expect("pr").number, 1);
    assert_eq!(head(&s, &k), main);
    assert_eq!(
        list(&s, &author, &k, Some(&imported.commit_sha))
            .items
            .len(),
        2
    );
    let removed = s.changes_apply(&author, input::<ChangesApply>(json!({"kbId":k,"baseRevision":imported.commit_sha,"proposalNumber":1,"proposalHeadSha":imported.commit_sha,"idempotencyKey":"asset-pr-remove-001","mode":"edit","title":"Remove proposal asset","sourceSessionIds":[],"changes":[{"op":"assetRemove","path":"a.png"}]}))).expect("remove in proposal");
    assert_eq!(removed.kind, ApplyKind::Proposed);
    assert_eq!(head(&s, &k), main);
    assert_eq!(
        list(&s, &author, &k, Some(&removed.commit_sha)).items.len(),
        1
    );
}

#[test]
fn primary_mixed_commit_canonical_manifest_and_retry_once() {
    let f = fixture::Fixture::new("manifest-primary");
    let s = Store::open(&f.root.join("store")).expect("store");
    let k = kb(&s, "primary");
    let base = head(&s, &k);
    let who = s.owner();
    assert!(list(&s, &who, &k, None).items.is_empty());
    let image = staged(&s, &who, &k, &png(), "asset", "image-upload-000001");
    let text = staged(
        &s,
        &who,
        &k,
        b"![pic](../media/z.png)\n",
        "markdown",
        "text-upload-0000001",
    );
    let changes = json!([{"op":"assetPut","path":"media/z.png","uploadId":image},{"op":"create","path":"docs/n.md","content":{"uploadId":text}}]);
    let out =
        apply(&s, &who, &k, &base, "mixed-publication-01", changes.clone()).expect("mixed commit");
    assert_eq!(out.changed_paths.len(), 2);
    assert_eq!(out.kind, ApplyKind::Applied);
    let expected = json!({"path":"media/z.png","hash":content_hash(&png()),"size":png().len(),"mime":"image/png"});
    let entries = list(&s, &who, &k, None).items;
    assert_eq!(serde_json::to_value(&entries[0]).expect("JSON"), expected);
    let doc = s
        .documents_get(
            &who,
            input::<DocumentsGet>(json!({"kbId":k,"path":"docs/n.md","rev":out.commit_sha})),
        )
        .expect("carry-in assetRefs");
    wire::<DocumentsGet>(&doc);
    assert_eq!(doc.asset_refs, entries);
    for id in [&image, &text] {
        assert_eq!(upload_state(&s, id), ("CONSUMED".into(), 0));
    }
    assert_eq!(count(&s, "asset_blobs"), 1);
    assert_eq!(count(&s, "kb_asset_lineage"), 1);
    assert_eq!(
        apply(&s, &who, &k, &base, "mixed-publication-01", changes.clone()).expect("retry"),
        out
    );
    assert_eq!(s.intents(&k).expect("receipts").len(), 2);
    assert_eq!(s.kb(&k).expect("record").expect("KB").desired_epoch, 2);
    rejected(
        apply(
            &s,
            &who,
            &k,
            &base,
            "mixed-publication-01",
            json!([{"op":"assetRemove","path":"media/z.png"}]),
        ),
        ErrorCode::IdempotencyMismatch,
    );
    let mut fx = fixture::Fixture::new("manifest-inspect");
    fx.repo = s.paths().repo_dir(&k);
    let bytes = fx.git(&["show", "main:.assets/manifest.json"]);
    assert_eq!(
        format!("{bytes}\n").as_bytes(),
        kb_local::tree::canonical_manifest_bytes(&[kb_local::tree::ManifestEntry {
            path: "media/z.png".into(),
            hash: content_hash(&png()).as_str().into(),
            size: png().len() as u64,
            mime: "image/png".into()
        }])
    );
    assert_eq!(fx.git(&["rev-list", "--count", "main"]), "2");
    assert_eq!(
        std::fs::read(kb_local::cas::blob_path(s.paths(), &content_hash(&png()))).expect("CAS"),
        png()
    );
}

#[test]
fn invalid_eighth_mixed_operation_preserves_ready_and_all_effects() {
    let f = fixture::Fixture::new("manifest-eighth");
    let s = Store::open(&f.root.join("store")).expect("store");
    let k = kb(&s, "eighth");
    let base = head(&s, &k);
    let who = principal(&s, &k, &[Permission::Propose]);
    let image = staged(&s, &who, &k, &png(), "asset", "eighth-image-000001");
    let text = staged(&s, &who, &k, b"# text\n", "markdown", "eighth-text-0000001");
    let mut changes = vec![
        json!({"op":"assetPut","path":"images/a.png","uploadId":image}),
        json!({"op":"create","path":"docs/a.md","content":{"uploadId":text}}),
    ];
    for i in 2..7 {
        changes
            .push(json!({"op":"create","path":format!("n{i}.md"),"content":{"markdown":"# note"}}));
    }
    changes.push(json!({"op":"replace","path":"missing.md","content":{"markdown":"bad"}}));
    rejected(
        apply(&s, &who, &k, &base, "eighth-rejected-001", json!(changes)),
        ErrorCode::InvalidArgument,
    );
    assert_eq!(head(&s, &k), base);
    assert_eq!(s.intents(&k).expect("intents").len(), 1);
    assert!(s.proposal(&k, 1).expect("PR").is_none());
    assert_eq!(count(&s, "kb_asset_lineage"), 0);
    assert_eq!(count(&s, "asset_blobs"), 0);
    for id in [&image, &text] {
        assert_eq!(upload_state(&s, id), ("READY".into(), 1));
    }
    changes[7] = json!({"op":"create","path":"n7.md","content":{"markdown":"# valid"}});
    assert_eq!(
        apply(&s, &who, &k, &base, "eighth-rejected-001", json!(changes))
            .expect("same-key valid")
            .kind,
        ApplyKind::Proposed
    );
}

#[test]
fn wrong_actor_kb_kind_incomplete_expired_and_consumed_are_rejected() {
    let f = fixture::Fixture::new("manifest-binding");
    let s = Store::open(&f.root.join("store")).expect("store");
    let k = kb(&s, "binding");
    let foreign = kb(&s, "foreign");
    let base = head(&s, &k);
    let who = s.owner();
    let image = staged(&s, &who, &k, &png(), "asset", "binding-image-0001");
    let text = staged(&s, &who, &k, b"# text", "markdown", "binding-text-00001");
    let pdf: Vec<u8> = media("minimalPdf")
        .into_iter()
        .map(|b| if b >= 128 { b'A' } else { b })
        .collect();
    let pdf_upload = staged(&s, &who, &k, &pdf, "asset", "kind-pdf-upload01");
    rejected(
        apply(
            &s,
            &who,
            &k,
            &base,
            "pdf-as-text-00001",
            json!([{"op":"create","path":"pdf.md","content":{"uploadId":pdf_upload}}]),
        ),
        ErrorCode::InvalidArgument,
    );
    let other = principal(&s, &k, &[Permission::Write]);
    rejected(
        put(&s, &other, &k, &base, &image, "a.png", "foreign-actor-0001"),
        ErrorCode::NotFound,
    );
    rejected(
        put(
            &s,
            &who,
            &foreign,
            &head(&s, &foreign),
            &image,
            "a.png",
            "foreign-kb-0000001",
        ),
        ErrorCode::NotFound,
    );
    rejected(
        put(&s, &who, &k, &base, &text, "a.png", "wrong-kind-000001"),
        ErrorCode::InvalidArgument,
    );
    rejected(
        apply(
            &s,
            &who,
            &k,
            &base,
            "image-as-text-0001",
            json!([{"op":"create","path":"a.md","content":{"uploadId":image}}]),
        ),
        ErrorCode::InvalidArgument,
    );
    let pending=s.upload_begin(&who,input::<UploadBegin>(json!({"kbId":k,"kind":"asset","size":png().len(),"mime":"image/png","contentHash":content_hash(&png()),"idempotencyKey":"not-ready-0000001"}))).expect("WRITING");
    rejected(
        put(
            &s,
            &who,
            &k,
            &base,
            &pending.upload_id,
            "a.png",
            "not-ready-put-001",
        ),
        ErrorCode::UploadIncomplete,
    );
    let first = put(&s, &who, &k, &base, &image, "a.png", "first-binding-001").expect("put");
    rejected(
        put(
            &s,
            &who,
            &k,
            &first.commit_sha,
            &image,
            "b.png",
            "reuse-binding-001",
        ),
        ErrorCode::Conflict,
    );
    let expired = staged(&s, &who, &k, &png(), "asset", "expired-image-001");
    s.advance_clock_for_tests(3601);
    rejected(
        put(
            &s,
            &who,
            &k,
            &first.commit_sha,
            &expired,
            "b.png",
            "expired-put-00001",
        ),
        ErrorCode::UploadExpired,
    );
}

#[test]
fn duplicate_and_whole_tree_path_collisions_have_zero_effects() {
    let f = fixture::Fixture::new("manifest-collisions");
    let s = Store::open(&f.root.join("store")).expect("store");
    let k = kb(&s, "collisions");
    let base = head(&s, &k);
    let who = s.owner();
    let id = staged(&s, &who, &k, &png(), "asset", "collision-upload-01");
    for (i, path) in ["index.md", "INDEX.md", ".gitignore/x.png", ".assets/x.png"]
        .iter()
        .enumerate()
    {
        rejected(
            put(
                &s,
                &who,
                &k,
                &base,
                &id,
                path,
                &format!("collision-key-{i:03}"),
            ),
            ErrorCode::InvalidArgument,
        );
    }
    rejected(
        apply(
            &s,
            &who,
            &k,
            &base,
            "duplicate-path-001",
            json!([{"op":"assetPut","path":"images/a.png","uploadId":id},{"op":"assetPut","path":"Images/A.png","uploadId":id}]),
        ),
        ErrorCode::InvalidArgument,
    );
    let first = put(&s, &who, &k, &base, &id, "Docs/a.png", "case-prefix-00001").expect("asset");
    rejected(
        apply(
            &s,
            &who,
            &k,
            &first.commit_sha,
            "prefix-collision-1",
            json!([{"op":"create","path":"docs/n.md","content":{"markdown":"text"}}]),
        ),
        ErrorCode::InvalidArgument,
    );
    assert_eq!(head(&s, &k), first.commit_sha);
    assert_eq!(count(&s, "kb_asset_lineage"), 1);
}

#[test]
fn historical_list_and_document_refs_survive_remove_without_cas_gc() {
    let f = fixture::Fixture::new("manifest-history");
    let s = Store::open(&f.root.join("store")).expect("store");
    let k = kb(&s, "history");
    let base = head(&s, &k);
    let who = s.owner();
    let id = staged(&s, &who, &k, &png(), "asset", "history-image-001");
    let first=apply(&s,&who,&k,&base,"history-first-001",json!([{"op":"assetPut","path":"a.png","uploadId":id},{"op":"create","path":"a.md","content":{"markdown":"![a](a.png)"}}])).expect("put");
    let removed = apply(
        &s,
        &who,
        &k,
        &first.commit_sha,
        "history-remove-01",
        json!([{"op":"assetRemove","path":"a.png"}]),
    )
    .expect("remove");
    // L-22: the removal succeeds but says which documents now dangle, and
    // the warning is part of the replayed receipt.
    assert_eq!(removed.warnings.len(), 1);
    assert_eq!(removed.warnings[0].path.as_str(), "a.png");
    assert_eq!(
        removed.warnings[0]
            .referenced_by
            .iter()
            .map(|p| p.as_str())
            .collect::<Vec<_>>(),
        ["a.md"]
    );
    wire::<ChangesApply>(&removed);
    let replay = apply(
        &s,
        &who,
        &k,
        &first.commit_sha,
        "history-remove-01",
        json!([{"op":"assetRemove","path":"a.png"}]),
    )
    .expect("replay");
    assert_eq!(replay, removed);
    assert!(list(&s, &who, &k, None).items.is_empty());
    assert_eq!(list(&s, &who, &k, Some(&first.commit_sha)).items.len(), 1);
    for (rev, n) in [(None, 0), (Some(first.commit_sha.clone()), 1)] {
        let mut v = json!({"kbId":k,"path":"a.md"});
        if let Some(r) = rev {
            v["rev"] = json!(r);
        }
        assert_eq!(
            s.documents_get(&who, input::<DocumentsGet>(v))
                .expect("document")
                .asset_refs
                .len(),
            n
        );
    }
    assert_eq!(count(&s, "kb_asset_lineage"), 1);
    assert!(kb_local::cas::blob_path(s.paths(), &content_hash(&png())).exists());
    let missing = apply(
        &s,
        &who,
        &k,
        &head(&s, &k),
        "remove-missing-001",
        json!([{"op":"assetRemove","path":"missing.png"}]),
    )
    .expect_err("reject");
    assert_eq!(missing.protocol_code(), ErrorCode::InvalidArgument);
    // As on the server: the reason and the change's path pointer.
    assert_eq!(
        missing.protocol_details(),
        json!({"reason": "PATH_NOT_FOUND", "field": "/changes/0/path"})
    );
}

#[test]
fn imports_require_live_source_membership_and_keep_independent_target_lineage() {
    let f = fixture::Fixture::new("manifest-import");
    let s = Store::open(&f.root.join("store")).expect("store");
    let source = kb(&s, "source");
    let target = kb(&s, "target");
    let unrelated = kb(&s, "unrelated");
    let source_base = head(&s, &source);
    let target_base = head(&s, &target);
    let who = s.owner();
    let hash = content_hash(&png());
    let id = staged(&s, &who, &source, &png(), "asset", "source-image-0001");
    let first = put(
        &s,
        &who,
        &source,
        &source_base,
        &id,
        "original.png",
        "source-put-000001",
    )
    .expect("source");
    let p = principal(&s, &target, &[Permission::Write]);
    let request = import_input(
        &target,
        &target_base,
        &source,
        &first.commit_sha,
        &hash,
        "import-success-01",
    );
    rejected(s.assets_import(&p, request.clone()), ErrorCode::NotFound);
    grant(&s, &p, &source, &[Permission::Read]);
    for (kb, rev, h) in [
        (&source, &source_base, &hash),
        (&unrelated, &first.commit_sha, &hash),
        (&source, &first.commit_sha, &content_hash(b"stolen")),
    ] {
        rejected(
            s.assets_import(
                &p,
                import_input(&target, &target_base, kb, rev, h, "invalid-source-01"),
            ),
            ErrorCode::NotFound,
        );
    }
    let mut fx = fixture::Fixture::new("unreachable");
    fx.repo = s.paths().repo_dir(&source);
    let dangling = Sha::parse(&fx.git(&[
        "commit-tree",
        &fx.git(&["rev-parse", "main^{tree}"]),
        "-m",
        "unreachable",
    ]))
    .expect("SHA");
    rejected(
        s.assets_import(
            &p,
            import_input(
                &target,
                &target_base,
                &source,
                &dangling,
                &hash,
                "unreachable-00001",
            ),
        ),
        ErrorCode::NotFound,
    );
    let out = s
        .assets_import(&p, request.clone())
        .expect("authorized copy");
    wire::<AssetsImport>(&out);
    grant(&s, &p, &source, &[]);
    assert_eq!(list(&s, &p, &target, None).items[0].hash, hash);
    assert_eq!(
        s.assets_import(&p, request)
            .expect("effect retry after source revoke"),
        out
    );
    assert_eq!(count(&s, "kb_asset_lineage"), 2);
    assert_eq!(count(&s, "asset_blobs"), 1);
    let row: (String, String, String) = rusqlite::Connection::open(s.paths().state_db())
        .expect("DB")
        .query_row(
            "SELECT source,source_kb_id,source_rev FROM kb_asset_lineage WHERE kb_id=?1",
            [target.as_str()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .expect("import lineage");
    assert_eq!(
        row,
        (
            "IMPORT".into(),
            source.as_str().into(),
            first.commit_sha.as_str().into()
        )
    );
    grant(&s, &p, &target, &[Permission::Read]);
    rejected(
        s.assets_import(
            &p,
            import_input(
                &target,
                &out.commit_sha,
                &source,
                &first.commit_sha,
                &hash,
                "read-only-target1",
            ),
        ),
        ErrorCode::Forbidden,
    );
    grant(&s, &p, &target, &[]);
    rejected(
        s.assets_list(&p, input::<AssetsList>(json!({"kbId":target}))),
        ErrorCode::NotFound,
    );
}

#[test]
fn proposals_only_update_owned_pr_and_merge_accepts_manifest() {
    let f = fixture::Fixture::new("manifest-pr");
    let s = Store::open(&f.root.join("store")).expect("store");
    let k = kb(&s, "proposal");
    let base = head(&s, &k);
    let p = principal(&s, &k, &[Permission::Propose]);
    let id = staged(&s, &p, &k, &png(), "asset", "proposal-image-01");
    let out = put(&s, &p, &k, &base, &id, "a.png", "proposal-put-0001").expect("propose");
    assert_eq!(out.kind, ApplyKind::Proposed);
    assert_eq!(head(&s, &k), base);
    assert_eq!(s.kb(&k).expect("KB").expect("record").desired_epoch, 1);
    assert!(list(&s, &p, &k, None).items.is_empty());
    assert_eq!(list(&s, &p, &k, Some(&out.commit_sha)).items.len(), 1);
    let id2 = staged(&s, &p, &k, &png(), "asset", "proposal-image-02");
    let second = put(
        &s,
        &p,
        &k,
        &out.commit_sha,
        &id2,
        "b.png",
        "proposal-put-0002",
    )
    .expect("reuse PR");
    assert_eq!(second.proposal.as_ref().expect("PR").number, 1);
    assert_eq!(count(&s, "kb_asset_lineage"), 1);
    let detail = s
        .pull_requests_get(
            &s.owner(),
            input::<PullRequestsGet>(json!({"kbId":k,"number":1})),
        )
        .expect("diff");
    assert_eq!(detail.touched_assets.len(), 2);
    let merged=s.pull_requests_review(&s.owner(),input::<PullRequestsReview>(json!({"kbId":k,"number":1,"decision":"merge","expectedHeadSha":second.commit_sha,"expectedTargetSha":base,"idempotencyKey":"merge-manifest-01","confirm":"MERGE"}))).expect("merge assets");
    assert_eq!(merged.pr.status, PrStatus::Merged);
    assert_eq!(list(&s, &p, &k, None).items.len(), 2);
}

#[test]
fn metadata_exact_and_hash_possession_cannot_launder_lineage() {
    let f = fixture::Fixture::new("manifest-trust");
    let s = Store::open(&f.root.join("store")).expect("store");
    let k = kb(&s, "trust");
    let base = head(&s, &k);
    let who = s.owner();
    kb_local::cas::publish_cas(
        s.paths(),
        std::io::Cursor::new(png()),
        &content_hash(&png()),
        png().len() as u64,
        Mime::ImagePng,
    )
    .expect("orphan CAS");
    let donor = kb(&s, "donor");
    let donor_upload = staged(&s, &who, &donor, &png(), "asset", "donor-upload-0001");
    put(
        &s,
        &who,
        &donor,
        &head(&s, &donor),
        &donor_upload,
        "a.png",
        "donor-publish-001",
    )
    .expect("foreign trusted catalog");
    let manifest = kb_local::tree::canonical_manifest_bytes(&[kb_local::tree::ManifestEntry {
        path: "stolen.png".into(),
        hash: content_hash(&png()).as_str().into(),
        size: png().len() as u64,
        mime: "image/png".into(),
    }]);
    let request = kb_local::CommitRequest {
        kb: k.clone(),
        base_revision: base.clone(),
        idempotency_key: "raw-manifest-0001".into(),
        changes: vec![kb_local::FileChange {
            path: ".assets/manifest.json".into(),
            content: Some(manifest),
        }],
    };
    assert!(
        s.commit_files(&who, request).is_err(),
        "raw hash cannot grant lineage"
    );
    let id = staged(&s, &who, &k, &png(), "asset", "trusted-image-001");
    let out =
        put(&s, &who, &k, &base, &id, "a.png", "trusted-put-00001").expect("legitimate upload");
    let db = rusqlite::Connection::open(s.paths().state_db()).expect("DB");
    db.execute(
        "UPDATE asset_blobs SET size=size+1 WHERE hash=?1",
        [content_hash(&png()).as_str()],
    )
    .expect("fault injection");
    rejected(
        s.assets_list(
            &who,
            input::<AssetsList>(json!({"kbId":k,"rev":out.commit_sha})),
        ),
        ErrorCode::StorageUnavailable,
    );
}

#[test]
fn paging_pins_revision_and_binds_actor_and_ttl() {
    let f = fixture::Fixture::new("manifest-pages");
    let s = Store::open(&f.root.join("store")).expect("store");
    let k = kb(&s, "pages");
    let who = s.owner();
    let base = head(&s, &k);
    let id = staged(&s, &who, &k, &png(), "asset", "paging-upload-001");
    let out=apply(&s,&who,&k,&base,"paging-publish-01",json!([{"op":"assetPut","path":"z.png","uploadId":id},{"op":"assetPut","path":"a.png","uploadId":id}])).expect("one upload multiple paths");
    let page = s
        .assets_list(&who, input::<AssetsList>(json!({"kbId":k,"limit":1})))
        .expect("page");
    assert_eq!(page.items[0].path.as_str(), "a.png");
    let token = page.next_cursor.expect("cursor");
    apply(
        &s,
        &who,
        &k,
        &out.commit_sha,
        "paging-remove-001",
        json!([{"op":"assetRemove","path":"z.png"}]),
    )
    .expect("new HEAD");
    let next = s
        .assets_list(
            &who,
            input::<AssetsList>(json!({"kbId":k,"limit":1,"cursor":token})),
        )
        .expect("pinned page");
    assert_eq!(next.items[0].path.as_str(), "z.png");
    assert!(next.next_cursor.is_none());
    let other = principal(&s, &k, &[Permission::Read]);
    rejected(
        s.assets_list(
            &other,
            input::<AssetsList>(json!({"kbId":k,"cursor":token})),
        ),
        ErrorCode::InvalidCursor,
    );
    s.advance_clock_for_tests(901);
    rejected(
        s.assets_list(&who, input::<AssetsList>(json!({"kbId":k,"cursor":token}))),
        ErrorCode::InvalidCursor,
    );
}

#[test]
fn imported_source_is_rechecked_before_committing_but_reserved_copy_survives_revoke() {
    for stage in [Stage::Prepared, Stage::Committing] {
        let f = fixture::Fixture::new("import-reservation");
        let s = Store::open(&f.root.join("store")).expect("store");
        let src = kb(&s, "src");
        let dst = kb(&s, "dst");
        let base = head(&s, &dst);
        let owner = s.owner();
        let id = staged(&s, &owner, &src, &png(), "asset", "reservation-image1");
        let source = put(
            &s,
            &owner,
            &src,
            &head(&s, &src),
            &id,
            "a.png",
            "reservation-put-01",
        )
        .expect("source");
        let p = principal(&s, &dst, &[Permission::Write]);
        grant(&s, &p, &src, &[Permission::Read]);
        let request = import_input(
            &dst,
            &base,
            &src,
            &source.commit_sha,
            &content_hash(&png()),
            "reservation-copy1",
        );
        let db = rusqlite::Connection::open(s.paths().state_db()).expect("DB");
        let result = s.assets_import_observed(&p, request, &mut |at| {
            if at == stage {
                db.execute(
                    "UPDATE principal_ceilings SET bits=0 WHERE principal_id=?1 AND kb_id=?2",
                    (p.id(), src.as_str()),
                )
                .expect("authority transition");
            }
            Ok(())
        });
        if stage == Stage::Prepared {
            rejected(result, ErrorCode::NotFound);
            assert_eq!(head(&s, &dst), base);
            assert!(list(&s, &p, &dst, None).items.is_empty());
        } else {
            assert!(result.is_ok());
            assert_eq!(list(&s, &p, &dst, None).items.len(), 1);
        }
    }
}

#[test]
fn staged_identical_replacement_noop_consumes_once_and_replays() {
    let f = fixture::Fixture::new("staged-noop");
    let s = Store::open(&f.root.join("store")).expect("store");
    let k = kb(&s, "noop");
    let who = s.owner();
    let base = head(&s, &k);
    let doc = s
        .documents_get(
            &who,
            input::<DocumentsGet>(json!({"kbId":k,"path":"index.md"})),
        )
        .expect("index");
    let id = staged(
        &s,
        &who,
        &k,
        doc.markdown.as_bytes(),
        "markdown",
        "noop-text-upload1",
    );
    let changes = json!([{"op":"replace","path":"index.md","content":{"uploadId":id}}]);
    let out = apply(&s, &who, &k, &base, "noop-staged-edit1", changes.clone()).expect("noop");
    assert_eq!(out.kind, ApplyKind::Noop);
    assert_eq!(upload_state(&s, &id), ("CONSUMED".into(), 0));
    assert_eq!(
        apply(&s, &who, &k, &base, "noop-staged-edit1", changes).expect("replay"),
        out
    );
    assert_eq!(head(&s, &k), base);
    assert_eq!(count(&s, "kb_asset_lineage"), 0);
}

#[test]
fn malformed_percent_escapes_select_literal_manifest_entries() {
    let f = fixture::Fixture::new("manifest-percent");
    let s = Store::open(&f.root.join("store")).expect("store");
    let k = kb(&s, "percent");
    let owner = s.owner();
    let paths = ["a%20%", "a %", "a%20%2", "a %2"];
    let mut changes = Vec::new();
    for (i, path) in paths.iter().enumerate() {
        let id = staged(
            &s,
            &owner,
            &k,
            &png(),
            "asset",
            &format!("percent-stage-{i:04}"),
        );
        changes.push(json!({"op":"assetPut","path":path,"uploadId":id}));
    }
    for (path, markdown) in [
        ("inline.md", "[x](a%20%) [y](a%20%2)"),
        (
            "references.md",
            "[x][one] [y][two]\n\n[one]: a%20%\n[two]: <a%20%2>",
        ),
        ("valid.md", "[x](a%20%25) [y](a%20%252)"),
        (
            "entities.md",
            "[x](a&#37;20&#37;) [y][two]\n\n[two]: <a&percnt;20&percnt;2>",
        ),
    ] {
        changes.push(json!({"op":"create","path":path,"content":{"markdown":markdown}}));
    }
    let out = apply(
        &s,
        &owner,
        &k,
        &head(&s, &k),
        "percent-batch-0001",
        json!(changes),
    )
    .expect("mixed batch");
    let reader = principal(&s, &k, &[Permission::Read]);
    for rev in [None, Some(out.commit_sha)] {
        for (path, expected) in [
            ("inline.md", vec!["a%20%", "a%20%2"]),
            ("references.md", vec!["a%20%", "a%20%2"]),
            ("valid.md", vec!["a %", "a %2"]),
            ("entities.md", vec!["a%20%", "a%20%2"]),
        ] {
            let mut request = json!({"kbId":k,"path":path});
            if let Some(rev) = &rev {
                request["rev"] = json!(rev);
            }
            let document = s
                .documents_get(&reader, input::<DocumentsGet>(request))
                .expect("document");
            wire::<DocumentsGet>(&document);
            let refs: Vec<_> = document
                .asset_refs
                .iter()
                .map(|r| r.path.as_str())
                .collect();
            assert_eq!(refs, expected, "{path}");
        }
    }
}

#[test]
fn markdown_reference_resolution_matches_server_and_is_bounded() {
    use kb_local::manifest::referenced_paths;
    let cases: Value = serde_json::from_str(include_str!(
        "../../../../../packages/api/src/lib/kb/fixtures/asset-reference-cases.json"
    ))
    .expect("shared references");
    for case in cases.as_array().expect("cases") {
        let source = case["markdown"].as_str().expect("markdown");
        let mut refs: Vec<_> = referenced_paths(source, "index.md").into_iter().collect();
        refs.sort();
        assert_eq!(json!(refs), case["paths"], "{source}");
    }
    for (source, path, expected) in [
        (
            "![a](/assets/a.png) ![b](../media/b.webp) ![c](c.png?width=2#frag)",
            "docs/n.md",
            vec!["assets/a.png", "docs/c.png", "media/b.webp"],
        ),
        (
            "[site](https://example.invalid/x.png) [frag](#section) `[x](secret.png)`\n```ts\n[f](fenced.png)\n```\n[real](real.png)",
            "index.md",
            vec!["real.png"],
        ),
        (
            "![pic][] ![b][REF]\n\n[pic]: images/a%20b.png\n[ref]: <images/spaced name.png> \"title\"",
            "index.md",
            vec!["images/a b.png", "images/spaced name.png"],
        ),
        (
            "[a b]\n\n[a\u{feff}b]: bom.png\n",
            "index.md",
            vec!["bom.png"],
        ),
        ("[a b]\n\n[a\u{85}b]: wrong.png\n", "index.md", vec![]),
        (
            "``a `[x](bad.png)` b``\n`multi\n[x](bad2.png)`\n\n    [x](bad3.png)\n[real](ok.png)",
            "index.md",
            vec!["ok.png"],
        ),
        (
            "Some text\n    [lazy](a.png)\n\n    [code](b.png)",
            "index.md",
            vec!["a.png"],
        ),
        (
            "Paragraph\n\u{feff}\n    [code](wrong.png)",
            "index.md",
            vec![],
        ),
        (
            "Paragraph\n\u{85}\n    [lazy](ok.png)",
            "index.md",
            vec!["ok.png"],
        ),
        (
            "[a](foo(bar).png 'tip') [b](<spaced name.png>) [bad]: wrong.png trailing junk\n[bad]",
            "index.md",
            vec!["foo(bar).png", "spaced name.png"],
        ),
        (
            "[a](%2F%2Fcdn.invalid/a.png) [b](%68ttps%3A%2F%2Fx.invalid/a.png) [c](../../outside.png) [d](a%2520b.png)",
            "docs/n.md",
            vec!["docs/a%20b.png"],
        ),
    ] {
        let mut got: Vec<_> = referenced_paths(source, path).into_iter().collect();
        got.sort();
        assert_eq!(got, expected, "{source}");
    }
    assert_eq!(
        referenced_paths("[a](a.png (nested (title)))", "index.md")
            .into_iter()
            .collect::<Vec<_>>(),
        vec!["a.png"]
    );
    assert!(
        referenced_paths(
            &format!("[use][a{}]\n[a]: wrong.png", " ".repeat(999)),
            "index.md"
        )
        .is_empty()
    );
    let expanding = "\u{130}".repeat(500);
    assert!(
        referenced_paths(&format!("[{expanding}]\n[{expanding}]: ok.png"), "index.md")
            .contains("ok.png")
    );
    let path = format!("{}.png", "a".repeat(460));
    assert!(
        referenced_paths(
            &format!("![pic]({}.png)", "&#0000097;".repeat(460)),
            "index.md"
        )
        .contains(&path)
    );
    // CommonMark only escapes ASCII punctuation, not a backslash before é.
    assert!(referenced_paths("[x](a\\é)", "index.md").contains("a\\é"));
    let repeated = format!(
        "{}\n[ref]: {}pic.png",
        "![pic][ref]\n".repeat(10000),
        "./".repeat(120000)
    );
    let started = scanner_work_clock();
    assert_eq!(
        referenced_paths(&repeated, "index.md"),
        ["pic.png".to_owned()].into_iter().collect()
    );
    assert!(scanner_work_clock().saturating_sub(started) < std::time::Duration::from_secs(2));
    assert!(
        referenced_paths("[bad]: wrong.png trailing [nested](wrong2.png)", "index.md").is_empty()
    );
    let start = scanner_work_clock();
    let refs = referenced_paths(
        &format!("{}](tail.png)", "[".repeat(512 * 1024)),
        "index.md",
    );
    assert_eq!(refs.into_iter().collect::<Vec<_>>(), vec!["tail.png"]);
    assert!(referenced_paths(&"[a](0[b](0[c](0".repeat(8 * 1024), "index.md").is_empty());
    assert!(scanner_work_clock() - start < std::time::Duration::from_secs(2));
}

// Scanner work is CPU work, not time spent waiting for the host scheduler.
// Linux CI exposes the owning thread's user/system ticks without unsafe code
// or another dependency. Other targets retain their previous wall-clock guard.
#[cfg(target_os = "linux")]
fn scanner_work_clock() -> std::time::Duration {
    static TICKS_PER_SECOND: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    let rate = *TICKS_PER_SECOND.get_or_init(|| {
        let output = std::process::Command::new("getconf")
            .arg("CLK_TCK")
            .output()
            .expect("clock tick query");
        assert!(output.status.success());
        String::from_utf8(output.stdout)
            .expect("ASCII clock tick rate")
            .trim()
            .parse::<u64>()
            .expect("positive integer tick rate")
    });
    let stat = std::fs::read_to_string("/proc/thread-self/stat")
        .expect("Linux owning-thread CPU counters");
    // comm can contain spaces/parentheses. The fields after its final ')' start
    // at state (field 3); utime/stime are fields 14/15.
    let fields = stat
        .rsplit_once(')')
        .expect("stat comm terminator")
        .1
        .split_whitespace()
        .collect::<Vec<_>>();
    let ticks = fields[11].parse::<u64>().expect("user CPU ticks")
        + fields[12].parse::<u64>().expect("system CPU ticks");
    std::time::Duration::from_secs(ticks / rate)
        + std::time::Duration::from_nanos((ticks % rate) * 1_000_000_000 / rate)
}
#[cfg(not(target_os = "linux"))]
fn scanner_work_clock() -> std::time::Duration {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed()
}

#[test]
fn dense_short_links_scan_within_the_document_work_bound() {
    let source = "[x](a.png)\n".repeat(131_072);
    assert!(source.len() <= kb_local::git_read::DOCUMENT_MAX_BYTES);
    let start = scanner_work_clock();
    let refs = kb_local::manifest::referenced_paths(&source, "index.md");
    assert_eq!(refs.into_iter().collect::<Vec<_>>(), vec!["a.png"]);
    assert!(
        scanner_work_clock() - start < std::time::Duration::from_secs(2),
        "CPU work: {:?}",
        scanner_work_clock() - start
    );
}

#[test]
fn manifest_crash_child() {
    let Some(root) = std::env::var_os("KB_MANIFEST_CHILD") else {
        return;
    };
    let root = std::path::PathBuf::from(root);
    let s = Store::open(&root.join("store")).expect("store");
    let body: Value =
        serde_json::from_slice(&std::fs::read(root.join("input.json")).expect("input"))
            .expect("JSON");
    let stage = std::env::var("KB_MANIFEST_STAGE").expect("stage");
    s.changes_apply_observed(&s.owner(), input::<ChangesApply>(body), &mut |st| {
        if format!("{st:?}") == stage {
            std::fs::write(root.join("parked"), b"ready").expect("marker");
            loop {
                std::thread::park();
            }
        }
        Ok(())
    })
    .expect("apply");
    panic!("stage not reached");
}

#[test]
fn interrupted_finalize_recovers_consumption_lineage_and_receipt_once() {
    for (stage, defer_startup) in [
        Stage::Prepared,
        Stage::Committing,
        Stage::RefMoved,
        Stage::Finalizing,
        Stage::Finalized,
    ]
    .into_iter()
    .flat_map(|stage| [false, true].map(|defer| (stage, defer)))
    {
        let f = fixture::Fixture::new("manifest-crash");
        let s = Store::open(&f.root.join("store")).expect("store");
        let k = kb(&s, "crash");
        let base = head(&s, &k);
        let who = s.owner();
        let id = staged(&s, &who, &k, &png(), "asset", "crash-upload-0001");
        let text = staged(&s, &who, &k, b"# staged", "markdown", "crash-text-000001");
        let body = json!({"kbId":k,"baseRevision":base,"idempotencyKey":"crash-publication1","mode":"edit","title":"Crash","changes":[{"op":"assetPut","path":"a.png","uploadId":id},{"op":"create","path":"a.md","content":{"uploadId":text}}],"sourceSessionIds":[]});
        std::fs::write(
            f.root.join("input.json"),
            serde_json::to_vec(&body).expect("JSON"),
        )
        .expect("input");
        drop(s);
        let mut c = fixture::ChildGuard::spawn(
            Command::new(std::env::current_exe().expect("exe"))
                .args(["--exact", "manifest_crash_child", "--nocapture"])
                .env("KB_MANIFEST_CHILD", &f.root)
                .env("KB_MANIFEST_STAGE", format!("{stage:?}"))
                .stdin(Stdio::null())
                .stdout(Stdio::null()),
        )
        .expect("child");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while !f.root.join("parked").exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "stage not reached {stage:?}"
            );
            assert!(c.try_wait().expect("child").is_none());
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        c.kill().expect("kill");
        c.wait().expect("drain");
        if stage == Stage::RefMoved {
            rusqlite::Connection::open(f.root.join("store/state.sqlite"))
                .expect("DB")
                .execute(
                    "UPDATE staged_uploads SET expires_ms=0 WHERE kb_id=?1",
                    [k.as_str()],
                )
                .expect("restart after TTL");
        }
        // Open only attempts nonblocking recovery. Exercise both ordinary
        // startup and deferred admission before using the owning read gate.
        let startup_lock = defer_startup.then(|| {
            let file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(f.root.join("store/locks/store.lock"))
                .expect("fixture fence");
            file.try_lock().expect("defer startup recovery");
            file
        });
        let s = Store::open(&f.root.join("store")).expect("restart");
        if let Some(file) = startup_lock {
            let row = s
                .intents(&k)
                .expect("intents")
                .into_iter()
                .find(|row| row.idempotency_key == "crash-publication1")
                .expect("publication intent");
            assert_eq!(
                row.phase,
                match stage {
                    Stage::Prepared => kb_local::Phase::Prepared,
                    Stage::Finalized => kb_local::Phase::Finalized,
                    _ => kb_local::Phase::Committing,
                },
                "{stage:?}: startup must respect the held fence"
            );
            assert_eq!(
                count(&s, "kb_asset_lineage"),
                i64::from(stage == Stage::Finalized),
                "{stage:?}: uncommitted lineage stays hidden"
            );
            file.unlock().expect("release startup fence");
        }
        let record = s.read_kb(&k).expect("read-only recovery gate");
        let published = matches!(
            stage,
            Stage::RefMoved | Stage::Finalizing | Stage::Finalized
        );
        assert_eq!(record.desired_epoch, if published { 2 } else { 1 });
        assert_eq!(
            count(&s, "kb_asset_lineage"),
            i64::from(published),
            "{stage:?}, deferred={defer_startup}: lineage recovered"
        );
        assert_eq!(
            count(&s, "asset_blobs"),
            i64::from(published),
            "{stage:?}, deferred={defer_startup}: catalog recovered"
        );
        for upload in [&id, &text] {
            assert_eq!(
                upload_state(&s, upload),
                if published {
                    ("CONSUMED".into(), 0)
                } else {
                    ("READY".into(), 1)
                }
            );
        }
        if published {
            let out = s
                .changes_apply(&s.owner(), input::<ChangesApply>(body.clone()))
                .expect("replay");
            assert_eq!(
                s.changes_apply(&s.owner(), input::<ChangesApply>(body))
                    .expect("again"),
                out
            );
            assert_eq!(list(&s, &s.owner(), &k, None).items.len(), 1);
            assert_eq!(s.kb(&k).expect("KB").expect("record").desired_epoch, 2);
        } else {
            rejected(
                s.changes_apply(&s.owner(), input::<ChangesApply>(body)),
                ErrorCode::Conflict,
            );
            assert_eq!(head(&s, &k), base);
        }
        assert_eq!(s.intents(&k).expect("receipts").len(), 2);
    }
}

#[test]
fn tombstone_cancels_prepared_upload_binding_even_when_kb_requires_repair() {
    let f = fixture::Fixture::new("manifest-tombstone");
    let s = Store::open(&f.root.join("store")).expect("store");
    let k = kb(&s, "tombstone");
    let owner = s.owner();
    let id = staged(&s, &owner, &k, &png(), "asset", "tombstone-upload1");
    let op = "00000000-0000-4000-8000-000000000055";
    let db = rusqlite::Connection::open(s.paths().state_db()).expect("DB");
    db.execute("INSERT INTO operation_intents(op_id,actor_key,kb_id,operation,idempotency_key,request_hash,phase,created_at) VALUES (?1,?2,?3,'ASSET_PUT','tombstone-pending1',?4,'PREPARED','2026-10-08T00:00:00Z')",(op,owner.actor_key(),k.as_str(),content_hash(b"fixture").as_str())).expect("prepared journal fixture");
    db.execute(
        "UPDATE staged_uploads SET reserved_by_op_id=?2 WHERE id=?1",
        (id.as_str(), op),
    )
    .expect("binding");
    db.execute(
        "UPDATE kbs SET state='REPAIR_REQUIRED' WHERE id=?1",
        [k.as_str()],
    )
    .expect("repair fixture");
    s.bases_delete(&owner, input::<BasesDelete>(json!({"kbId":k,"metadataVersion":1,"idempotencyKey":"tombstone-delete1","confirm":"DELETE"}))).expect("tombstone");
    let bound: Option<String> = db
        .query_row(
            "SELECT reserved_by_op_id FROM staged_uploads WHERE id=?1",
            [id.as_str()],
            |r| r.get(0),
        )
        .expect("binding");
    assert!(
        bound.is_none(),
        "aborted reservation must permit expiry cleanup"
    );
    s.advance_clock_for_tests(3601);
    s.sweep_uploads().expect("cleanup");
    assert_eq!(upload_state(&s, &id), ("EXPIRED".into(), 0));
    assert!(!s.paths().uploads_dir().join(id.as_str()).exists());
}

#[test]
fn lineage_quota_includes_pending_reservations_and_releases_consumed_credit() {
    let f = fixture::Fixture::new("manifest-quota");
    let s = Store::open(&f.root.join("store")).expect("store");
    let source = kb(&s, "quota-source");
    let target = kb(&s, "quota-target");
    let who = s.owner();
    let image = staged(&s, &who, &source, &png(), "asset", "quota-source-upload");
    let first = put(
        &s,
        &who,
        &source,
        &head(&s, &source),
        &image,
        "image.png",
        "quota-source-put01",
    )
    .expect("source");
    let pending = s.upload_begin(&who,input::<UploadBegin>(json!({"kbId":target,"kind":"markdown","size":2097152,"contentHash":content_hash(&vec![b'a';2097152]),"mime":"text/markdown","idempotencyKey":"quota-pending-0001"}))).expect("reservation");
    // Fixture retained catalog: bounded rows model historical storage without
    // writing a gigabyte of immutable blobs just to exercise quota accounting.
    {
        let _g = s.lock_write(std::slice::from_ref(&target)).expect("lock");
        let mut db = rusqlite::Connection::open(s.paths().state_db()).expect("DB");
        let tx = db.transaction().expect("transaction");
        let mut remaining = (1i64 << 30) - 2097152;
        let mut n = 0;
        while remaining > 0 {
            let size = remaining.min(26214400);
            let hash = format!("sha256:{n:064x}");
            tx.execute(
                "INSERT INTO asset_blobs VALUES (?1,?2,'image/png','fixture')",
                (&hash, size),
            )
            .expect("catalog");
            tx.execute(
                "INSERT INTO kb_asset_lineage VALUES (?1,?2,'fixture','UPLOAD',NULL,NULL)",
                (target.as_str(), &hash),
            )
            .expect("lineage");
            remaining -= size;
            n += 1;
        }
        tx.commit().expect("commit");
    }
    let base = head(&s, &target);
    let request = import_input(
        &target,
        &base,
        &source,
        &first.commit_sha,
        &content_hash(&png()),
        "quota-import-0001",
    );
    let receipts = count(&s, "operation_intents");
    rejected(s.assets_import(&who, request), ErrorCode::QuotaExceeded);
    assert_eq!(head(&s, &target), base);
    assert_eq!(count(&s, "operation_intents"), receipts);
    assert_eq!(upload_state(&s, &pending.upload_id), ("WRITING".into(), 1));
    // Fill all but one PNG's budget after releasing the placeholder. The
    // legitimate PNG consumer must receive credit for its own reservation.
    s.advance_clock_for_tests(3601);
    s.sweep_uploads().expect("cleanup");
    {
        let _g = s.lock_write(std::slice::from_ref(&target)).expect("lock");
        let db = rusqlite::Connection::open(s.paths().state_db()).expect("DB");
        let hash = format!("sha256:{:064x}", 999);
        db.execute(
            "INSERT INTO asset_blobs VALUES (?1,?2,'image/png','fixture')",
            (&hash, 2097152 - png().len() as i64),
        )
        .expect("catalog");
        db.execute(
            "INSERT INTO kb_asset_lineage VALUES (?1,?2,'fixture','UPLOAD',NULL,NULL)",
            (target.as_str(), &hash),
        )
        .expect("lineage");
    }
    let own = staged(&s, &who, &target, &png(), "asset", "quota-own-upload01");
    put(
        &s,
        &who,
        &target,
        &base,
        &own,
        "own.png",
        "quota-own-put-0001",
    )
    .expect("released upload credit");
}

#[cfg(target_os = "linux")]
#[test]
fn scanner_work_clock_excludes_off_cpu_waiting() {
    let start = scanner_work_clock();
    std::thread::sleep(std::time::Duration::from_millis(2100));
    assert!(scanner_work_clock() - start < std::time::Duration::from_secs(2));
}

#[test]
fn l22_removing_an_asset_with_its_only_reference_warns_nothing() {
    let f = fixture::Fixture::new("manifest-warning");
    let s = Store::open(&f.root.join("store")).expect("store");
    let k = kb(&s, "warning");
    let base = head(&s, &k);
    let who = s.owner();
    let id = staged(&s, &who, &k, &png(), "asset", "warning-image-0001");
    let first=apply(&s,&who,&k,&base,"warning-first-0001",json!([{"op":"assetPut","path":"img/a.png","uploadId":id},{"op":"create","path":"notes/a.md","content":{"markdown":"![a](../img/a.png)"}}])).expect("put");
    assert!(first.warnings.is_empty());
    let both = apply(
        &s,
        &who,
        &k,
        &first.commit_sha,
        "warning-remove-0001",
        json!([{"op":"assetRemove","path":"img/a.png"},{"op":"delete","path":"notes/a.md"}]),
    )
    .expect("remove both");
    assert!(both.warnings.is_empty(), "{:?}", both.warnings);
}
