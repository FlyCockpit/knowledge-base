//! Registry views: repair rows, selected-KB listings and session metadata.

use super::*;

#[test]
fn repair_rows_stay_in_the_registry_but_are_not_common_attachments() {
    let root = temp_root("attachment-repair");
    let store = Store::open(&root).expect("open");
    let owner = store.owner();
    let created = create(&store, &owner, "repair", "create-repair-00001");
    let kb = kb_of(&created);
    let db = rusqlite::Connection::open(store.paths().state_db()).expect("db");
    db.execute(
        "UPDATE kbs SET state='REPAIR_REQUIRED', head_sha=NULL WHERE id=?1",
        [kb.as_str()],
    )
    .expect("mark repair");
    let update = input::<BasesUpdate>(
        json!({ "kbId": kb.as_str(), "metadataVersion": 1, "name": "New", "idempotencyKey": "repair-update-00001" }),
    );
    assert_eq!(
        code(
            store
                .bases_update(&owner, update.clone())
                .expect_err("repair update")
        ),
        ErrorCode::RepairRequired
    );
    assert_eq!(
        store
            .kb(&kb)
            .expect("registry")
            .expect("row")
            .metadata_version,
        1
    );
    let listed = store
        .bases_list(&owner, input::<BasesList>(json!({})))
        .expect("list");
    assert!(listed.items.is_empty());
    assert_eq!(
        code(get_kb(&store, &owner, &kb).expect_err("unready attachment")),
        ErrorCode::RepairRequired
    );
    assert!(
        store
            .kb(&kb)
            .expect("registry")
            .expect("retained row")
            .head_sha
            .is_none()
    );
    assert_eq!(
        store.kb(&kb).expect("registry").expect("row").name,
        created["kb"]["name"].as_str().expect("name")
    );
    assert!(
        !store
            .intents(&kb)
            .expect("receipts")
            .iter()
            .any(|intent| intent.operation == "KB_UPDATE")
    );
    // Rejection must leave the key reusable when the KB is ready again.
    db.execute(
        "UPDATE kbs SET state='ACTIVE', head_sha=?2 WHERE id=?1",
        (kb.as_str(), head_of(&created).as_str()),
    )
    .expect("restore active fixture");
    let updated = store
        .bases_update(&owner, update.clone())
        .expect("update restored kb");
    let output = wire::<BasesUpdate>(&updated);
    assert_eq!(output["kb"]["name"], "New");
    assert_eq!(output["kb"]["metadataVersion"], 2);
    assert_eq!(
        store.bases_update(&owner, update).expect("update replay"),
        updated
    );
    assert_eq!(
        get_kb(&store, &owner, &kb).expect("get")["kb"],
        output["kb"]
    );
    assert_eq!(
        wire::<BasesList>(
            &store
                .bases_list(&owner, input::<BasesList>(json!({})))
                .expect("list restored kb")
        )["items"],
        json!([output["kb"]])
    );
    // Attachment readiness must not remove the owner's repair-row tombstone
    // capability, whose reply carries no attachment or private revision.
    db.execute(
        "UPDATE kbs SET state='REPAIR_REQUIRED', head_sha=NULL WHERE id=?1",
        [kb.as_str()],
    )
    .expect("mark repair again");
    let deleted = store
        .bases_delete(
            &owner,
            input::<BasesDelete>(json!({
                "kbId": kb, "metadataVersion": 2, "confirm": "DELETE",
                "idempotencyKey": "repair-delete-00001",
            })),
        )
        .expect("owner tombstones repair row");
    assert_eq!(wire::<BasesDelete>(&deleted)["tombstoned"], true);
    assert_eq!(
        store
            .kb(&kb)
            .expect("registry")
            .expect("retained row")
            .state,
        kb_local::KbState::Tombstoned
    );
    drop(db);
    drop(store);
    std::fs::remove_dir_all(root.parent().expect("fixture parent")).expect("cleanup");
}

#[test]
fn selected_kb_list_pages_and_cursors_hold_only_selected_ids() {
    let root = temp_root("selected-list");
    let store = Store::open(&root).expect("open");
    let owner = store.owner();
    let mut ids: Vec<String> = ["sel-one", "sel-two", "sel-three", "sel-four"]
        .iter()
        .enumerate()
        .map(|(i, slug)| {
            kb_of(&create(
                &store,
                &owner,
                slug,
                &format!("selected-list-key-{i}"),
            ))
            .as_str()
            .to_owned()
        })
        .collect();
    ids.sort();
    let page = |selection: &std::collections::BTreeSet<String>, cursor: Option<&str>| {
        let mut args = json!({"limit": 1});
        if let Some(cursor) = cursor {
            args["cursor"] = json!(cursor);
        }
        store
            .bases_list_selected(&owner, input::<BasesList>(args), Some(selection))
            .map(|page| wire::<BasesList>(&page))
    };
    let ids_of = |page: &Value| -> Vec<String> {
        page["items"]
            .as_array()
            .expect("items")
            .iter()
            .map(|kb| kb["id"].as_str().expect("id").to_owned())
            .collect()
    };
    // Only the last KB selected: excluded KBs take no page slot and make no cursor.
    let last: std::collections::BTreeSet<String> = [ids[3].clone()].into();
    let only = page(&last, None).expect("page");
    assert_eq!(ids_of(&only), [ids[3].clone()]);
    assert!(only["nextCursor"].is_null());
    // Two of four, one per page: every cursor follows a selected row.
    let two: std::collections::BTreeSet<String> = [ids[0].clone(), ids[2].clone()].into();
    let first = page(&two, None).expect("page");
    assert_eq!(ids_of(&first), [ids[0].clone()]);
    let cursor = first["nextCursor"].as_str().expect("cursor").to_owned();
    let second = page(&two, Some(&cursor)).expect("page");
    assert_eq!(ids_of(&second), [ids[2].clone()]);
    assert!(second["nextCursor"].is_null());
    // A cursor is bound to its selection (and to no selection).
    assert_eq!(
        code(page(&last, Some(&cursor)).unwrap_err()),
        ErrorCode::InvalidCursor
    );
    assert_eq!(
        code(
            store
                .bases_list(
                    &owner,
                    input::<BasesList>(json!({"limit": 1, "cursor": cursor}))
                )
                .unwrap_err()
        ),
        ErrorCode::InvalidCursor
    );
}

#[test]
fn session_metadata_reads_live_authority_without_side_effects() {
    use kb_local::metadata::StoreMetadata;
    let root = temp_root("session-metadata");
    let store = Store::open(&root).expect("open");
    let owner = store.owner();
    let a = kb_of(&create(&store, &owner, "meta-a", "metadata-key-00001"));
    let b = kb_of(&create(&store, &owner, "meta-b", "metadata-key-00002"));
    let principal = reader(&store, &a, &[Permission::Read]);
    let db = rusqlite::Connection::open(root.join("state.sqlite")).expect("fixture");
    db.execute(
        "INSERT INTO principal_ceilings (principal_id, kind, kb_id, bits) VALUES (?1, 'TEST', ?2, 4)",
        (principal.id(), b.as_str()),
    )
    .expect("second ceiling");
    let meta = StoreMetadata::open(store.paths(), store.store_uuid()).expect("metadata");
    let found = meta.authority(&principal, None).expect("authority");
    assert!(!found.owner);
    assert!(found.create.is_none());
    let kbs = found.kbs.expect("narrowed");
    assert_eq!(kbs.len(), 2);
    let bits_of = |kb: &KbId| kbs.iter().find(|(id, _)| id == kb).expect("kb").1;
    assert_eq!(bits_of(&a).permissions(), [Permission::Read]);
    assert_eq!(
        bits_of(&b).permissions(),
        [Permission::Read, Permission::Propose, Permission::Write]
    );
    assert!(found.ceiling.contains(Permission::Write));
    // The selection limits both the KBs and the ceiling.
    let only_a: std::collections::BTreeSet<String> = [a.as_str().to_owned()].into();
    let narrowed = meta
        .authority(&principal, Some(&only_a))
        .expect("authority");
    assert_eq!(narrowed.kbs.expect("narrowed").len(), 1);
    assert!(!narrowed.ceiling.contains(Permission::Write));
    // Revocation and tombstones show on the next read.
    let guard = store.lock_write(&[]).expect("lock");
    store
        .set_principal_permissions(&guard, &principal, &a, &[])
        .expect("revoke");
    drop(guard);
    let version = get_kb(&store, &owner, &b).expect("kb")["kb"]["metadataVersion"].clone();
    store
        .bases_delete(
            &owner,
            input::<BasesDelete>(json!({"kbId": b, "metadataVersion": version,
                "confirm": "DELETE", "idempotencyKey": "metadata-delete-001"})),
        )
        .expect("delete");
    assert_eq!(
        meta.authority(&principal, None).expect("authority").kbs,
        Some(vec![])
    );
    let owned = meta
        .authority(
            &owner,
            Some(&[a.as_str().to_owned(), b.as_str().to_owned()].into()),
        )
        .expect("owner");
    assert!(owned.owner && owned.create.is_some());
    assert_eq!(owned.kbs.expect("narrowed").len(), 1);
    assert_eq!(meta.authority(&owner, None).expect("owner").kbs, None);
    // Opening reads only: a missing registry is not recreated. The store's
    // own connection closes first: Windows never renames an open database.
    let detached = root.with_file_name("detached-state.sqlite");
    let (paths, uuid) = (store.paths().clone(), store.store_uuid().clone());
    drop(meta);
    drop(db);
    drop(store);
    std::fs::rename(root.join("state.sqlite"), &detached).expect("detach");
    assert!(StoreMetadata::open(&paths, &uuid).is_err());
    assert!(!root.join("state.sqlite").exists());
    std::fs::rename(&detached, root.join("state.sqlite")).expect("restore");
}

#[test]
fn session_metadata_never_truncates_behind_retained_history() {
    use kb_local::metadata::StoreMetadata;
    let root = temp_root("metadata-history");
    let store = Store::open(&root).expect("open");
    let owner = store.owner();
    let live = kb_of(&create(&store, &owner, "live-kb", "history-key-000001"));
    let principal = reader(&store, &live, &[Permission::Write]);
    let mut db = rusqlite::Connection::open(root.join("state.sqlite")).expect("fixture");
    let tx = db.transaction().expect("fixture");
    // 4,100 tombstoned KBs whose IDs sort before the live one, each keeping
    // a read ceiling row for the principal (retained history).
    for n in 0..4100 {
        let id = format!("{n:0>24}");
        tx.execute(
            "INSERT INTO kbs (id, name, slug, description, state, created_at) \
             VALUES (?1, 'Old', ?1, 'Tombstoned history', 'TOMBSTONED', '2026-01-01T00:00:00Z')",
            [id.as_str()],
        )
        .expect("history kb");
        tx.execute(
            "INSERT INTO principal_ceilings (principal_id, kind, kb_id, bits) VALUES (?1, 'TEST', ?2, 1)",
            (principal.id(), id.as_str()),
        )
        .expect("history ceiling");
    }
    tx.commit().expect("fixture");
    let meta = StoreMetadata::open(store.paths(), store.store_uuid()).expect("metadata");
    let found = meta.authority(&principal, None).expect("authority");
    assert!(
        found.ceiling.contains(Permission::Write),
        "live ceiling kept"
    );
    let kbs = found.kbs.expect("one live KB is narrowed");
    assert_eq!(kbs.len(), 1);
    assert_eq!(kbs[0].0, live);
    assert!(kbs[0].1.contains(Permission::Write));
    let selected: std::collections::BTreeSet<String> = [live.as_str().to_owned()].into();
    let found = meta
        .authority(&principal, Some(&selected))
        .expect("authority");
    assert_eq!(found.kbs.expect("narrowed").len(), 1);
    assert!(found.ceiling.contains(Permission::Write));
}
