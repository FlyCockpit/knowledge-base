//! Side-effect-free metadata reads for a `kb mcp --root` session: scoped
//! discovery (`tools/list`) and pre-handler admission. Unlike
//! [`Store::reopen`](crate::Store::reopen), opening never creates directories,
//! starts the upload timer, takes a lock or runs recovery; it only checks the
//! launched identity and reads `state.sqlite`.
use std::collections::BTreeSet;

use kb_client::types::{KbId, Uuid};
use rusqlite::{Connection, OptionalExtension};

use crate::{
    Bits, LocalPrincipal, StoreError, StorePaths, state::open_read_only_bound, store::state_present,
};

/// Above this many readable KBs, discovery narrows no `kbId` (the server's
/// enum cap); reads stop one row past it.
pub const DISCOVERY_ENUM_MAX_KBS: usize = 25;

/// What a principal may hold, for discovery only (calls re-authorize live).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionAuthority {
    /// The store owner (every bit on every live KB, sole deleter).
    pub owner: bool,
    /// Expanded union of the stored ceilings within the selection.
    pub ceiling: Bits,
    /// Expanded bits a KB this principal creates would grant; `None` without
    /// a create capability.
    pub create: Option<Bits>,
    /// ACTIVE KBs in the selection the principal can read now, by ID, with
    /// expanded effective bits. `None` narrows nothing: the owner without a
    /// selection, or more than [`DISCOVERY_ENUM_MAX_KBS`] KBs.
    pub kbs: Option<Vec<(KbId, Bits)>>,
}

/// A read-only view of a launched store's registry.
pub struct StoreMetadata {
    conn: Connection,
    owner_id: String,
}

impl StoreMetadata {
    /// Identity-checked, side-effect-free open of the launched store.
    pub fn open(paths: &StorePaths, store_uuid: &Uuid) -> Result<Self, StoreError> {
        paths.check_identity().map_err(|e| match e {
            StoreError::Io(e) if e.kind() == std::io::ErrorKind::NotFound => {
                StoreError::RecoveryRequired("launched store root is missing".into())
            }
            e => e,
        })?;
        if !state_present(paths)? {
            return Err(StoreError::RecoveryRequired(
                "`state.sqlite` is missing".into(),
            ));
        }
        paths.check_no_follow(&paths.state_db())?;
        let conn = open_read_only_bound(&paths.state_db(), store_uuid)?;
        let owner_id = conn.query_row(
            "SELECT owner_principal_id FROM store_meta WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        Ok(Self { conn, owner_id })
    }

    /// The kind (`markdown` or `asset`) of `who`'s staged upload `id` in
    /// `kb`. A staged kind never changes, so this unlocked read is exact; an
    /// unknown row is `None` and the call itself later fails `NOT_FOUND`.
    pub fn staged_upload_kind(
        &self,
        who: &LocalPrincipal,
        kb: &KbId,
        id: &Uuid,
    ) -> Result<Option<String>, StoreError> {
        Ok(self
            .conn
            .query_row(
                "SELECT kind FROM staged_uploads WHERE id=?1 AND kb_id=?2 AND actor_key=?3",
                (id.as_str(), kb.as_str(), who.actor_key()),
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Current discovery authority of `who` within `selection` (`None`:
    /// every KB). The ceiling is one SQL aggregate over every ceiling row in
    /// the selection, and the KB list is filtered to selected, ACTIVE,
    /// readable KBs before its bound (one row past the enum cap), so retained
    /// history never truncates either.
    pub fn authority(
        &self,
        who: &LocalPrincipal,
        selection: Option<&BTreeSet<String>>,
    ) -> Result<SessionAuthority, StoreError> {
        let selected = selection
            .map(serde_json::to_string)
            .transpose()
            .map_err(|_| StoreError::Internal("selection".into()))?;
        let cap = i64::try_from(DISCOVERY_ENUM_MAX_KBS + 1).unwrap_or(i64::MAX);
        let in_selection = "(?3 IS NULL OR {col} IN (SELECT value FROM json_each(?3)))";
        let collect = |rows: Vec<(String, i64)>| -> Result<Option<Vec<(KbId, Bits)>>, StoreError> {
            if rows.len() > DISCOVERY_ENUM_MAX_KBS {
                return Ok(None);
            }
            rows.into_iter()
                .map(|(id, raw)| {
                    KbId::parse(&id)
                        .map(|kb| (kb, Bits::from_raw(raw).expand()))
                        .map_err(|_| StoreError::RecoveryRequired("malformed kb id".into()))
                })
                .collect::<Result<Vec<_>, _>>()
                .map(Some)
        };
        let Some(kind) = who.kind().as_db() else {
            if who.id() != self.owner_id {
                return Err(StoreError::NotFound);
            }
            let kbs = match &selected {
                None => None,
                Some(_) => {
                    let mut stmt = self.conn.prepare(
                        "SELECT id, 31 FROM kbs WHERE state = 'ACTIVE' AND head_sha IS NOT NULL \
                           AND id IN (SELECT value FROM json_each(?1)) ORDER BY id LIMIT ?2",
                    )?;
                    let rows = stmt
                        .query_map((selected.as_deref(), cap), |r| Ok((r.get(0)?, r.get(1)?)))?
                        .collect::<Result<Vec<_>, _>>()?;
                    collect(rows)?
                }
            };
            return Ok(SessionAuthority {
                owner: true,
                ceiling: Bits::ALL.expand(),
                create: Some(Bits::ALL.expand()),
                kbs,
            });
        };
        let create: Option<i64> = self
            .conn
            .query_row(
                "SELECT created_kb_bits FROM create_capabilities WHERE principal_id = ?1 AND kind = ?2",
                (who.id(), kind),
                |row| row.get(0),
            )
            .optional()?;
        // Bit union over every ceiling row in the selection, in SQL (no rows
        // are fetched, so none can be dropped).
        let ceiling: i64 = self.conn.query_row(
            &format!(
                "SELECT coalesce(max(bits & 1), 0) | coalesce(max(bits & 2), 0) \
                      | coalesce(max(bits & 4), 0) | coalesce(max(bits & 8), 0) \
                      | coalesce(max(bits & 16), 0) \
                   FROM principal_ceilings \
                  WHERE principal_id = ?1 AND kind = ?2 AND {}",
                in_selection.replace("{col}", "kb_id")
            ),
            (who.id(), kind, selected.as_deref()),
            |row| row.get(0),
        )?;
        // Any nonzero ceiling expands to include read.
        let mut stmt = self.conn.prepare(&format!(
            "SELECT c.kb_id, c.bits FROM principal_ceilings c JOIN kbs k ON k.id = c.kb_id \
              WHERE c.principal_id = ?1 AND c.kind = ?2 AND c.bits <> 0 \
                AND k.state = 'ACTIVE' AND k.head_sha IS NOT NULL AND {} \
              ORDER BY c.kb_id LIMIT ?4",
            in_selection.replace("{col}", "c.kb_id")
        ))?;
        let rows = stmt
            .query_map((who.id(), kind, selected.as_deref(), cap), |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(SessionAuthority {
            owner: false,
            ceiling: Bits::from_raw(ceiling).expand(),
            create: create.map(|raw| Bits::from_raw(raw).expand()),
            kbs: collect(rows)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Store;

    fn header(path: &std::path::Path) -> Vec<u8> {
        std::fs::read(path).expect("state")[..100].to_vec()
    }

    #[test]
    fn metadata_connections_are_read_only_and_fail_closed_without_a_writer() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let base =
            std::env::temp_dir().join(format!("kb-local-metadata-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&base).expect("base");
        let base = crate::test_temp::TestDir::new(base);
        let store = Store::open(&base.join("store")).expect("store");
        let paths = store.paths().clone();
        let uuid = store.store_uuid().clone();
        let db = paths.state_db();
        let before = header(&db);
        let meta = StoreMetadata::open(&paths, &uuid).expect("metadata");
        meta.authority(&store.owner(), None).expect("authority");
        for write in [
            "UPDATE store_meta SET created_at = created_at",
            "PRAGMA journal_mode = DELETE",
            "PRAGMA user_version = 7",
            "CREATE TABLE scratch (x)",
        ] {
            assert!(meta.conn.execute_batch(write).is_err(), "{write}");
        }
        let mode: String = meta
            .conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .expect("mode");
        assert_eq!(mode.to_ascii_lowercase(), "wal");
        drop(meta);
        assert_eq!(header(&db), before, "no persistent setting changed");
        // No live writer: WAL side files are gone, and a read-only open
        // neither recreates them nor falls back to read-write.
        drop(store);
        let side = |suffix: &str| db.with_file_name(format!("state.sqlite{suffix}"));
        assert!(
            !side("-shm").exists() && !side("-wal").exists(),
            "writer closed"
        );
        {
            let error = StoreMetadata::open(&paths, &uuid)
                .err()
                .expect("fails closed");
            assert_eq!(
                error.protocol_code(),
                kb_client::ErrorCode::StorageUnavailable
            );
            assert!(!side("-shm").exists() && !side("-wal").exists());
        }
        assert_eq!(header(&db), before);
    }
}
